//! Native macOS drag-out with an NSFilePromiseProvider.
//!
//! A promised file lets the user drag a video row to Finder/Desktop and get
//! the real file at the drop location even when it hasn't been downloaded
//! yet: Finder shows the copy (+) cursor, accepts the drop, then calls back
//! asking us to *write* the file into the destination folder — at which point
//! we download to the offline store (if needed) and copy.
//!
//! The provider subclass also writes the video's web URL as `public.url` /
//! `public.utf8-plain-text`, so dropping a row on an in-app tag folder keeps
//! working (WKWebView surfaces those as text/uri-list / text/plain).
//!
//! Scaffolding (drag source, event synthesis, session start) mirrors the
//! `drag` crate's macOS implementation, which this app already ships.

#![cfg(target_os = "macos")]

use std::path::PathBuf;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApp, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource,
    NSDragOperation, NSEvent, NSEventModifierFlags, NSEventType, NSFilePromiseProvider,
    NSFilePromiseProviderDelegate, NSImage, NSPasteboard, NSPasteboardType,
    NSPasteboardWriting, NSView,
};
use objc2_foundation::{
    NSArray, NSData, NSError, NSMutableArray, NSObject, NSObjectProtocol, NSOperationQueue,
    NSPoint, NSRect, NSSize, NSString, NSURL,
};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::AppHandle;

/// Produce the promised file at `dest`, then report through `done`. Invoked on
/// the main thread; implementations must do slow work asynchronously.
pub type WriteFn = Box<dyn Fn(PathBuf, Box<dyn FnOnce(Result<(), String>) + Send>) + Send + Sync>;
/// Drag session ended; the bool is "was actually dropped" (vs. cancelled).
pub type EndFn = Box<dyn Fn(bool) + Send + Sync>;

pub struct PromiseDragOptions {
    /// Filename the receiver should create, e.g. "Title (2024).mp4".
    pub file_name: String,
    /// UTI for the promised content, e.g. "public.mpeg-4".
    pub file_type_uti: String,
    /// The video's web URL — written as text types for in-app/other-app drops.
    pub url_text: String,
    /// PNG bytes for the drag image.
    pub png: Vec<u8>,
}

/// ObjC completion blocks aren't Send at the type level, but Finder's
/// completion handler is safe to *transport* across threads as long as we
/// invoke it on the main thread (which we do, via run_on_main_thread).
struct SendBlock(block2::RcBlock<dyn Fn(*mut NSError)>);
unsafe impl Send for SendBlock {}
impl SendBlock {
    /// Method (rather than field access) so closures capture the whole Send
    /// wrapper, not the !Send inner block (Rust 2021 disjoint capture).
    fn invoke(&self, err: *mut NSError) {
        self.0.call((err,));
    }
}

// ---------------------------------------------------------------------------
// Provider subclass: NSFilePromiseProvider + URL text pasteboard types.

struct ProviderIvars {
    url_text: String,
}

define_class!(
    #[unsafe(super(NSFilePromiseProvider))]
    #[name = "VidMinderPromiseProvider"]
    #[ivars = ProviderIvars]
    struct VidMinderPromiseProvider;

    unsafe impl NSObjectProtocol for VidMinderPromiseProvider {}

    /// Overrides of the superclass's NSPasteboardWriting conformance, adding
    /// the video URL as plain text alongside the file promise.
    unsafe impl NSPasteboardWriting for VidMinderPromiseProvider {
        #[unsafe(method_id(writableTypesForPasteboard:))]
        fn writable_types(&self, pasteboard: &NSPasteboard) -> Retained<NSArray<NSPasteboardType>> {
            let sup: Retained<NSArray<NSPasteboardType>> =
                unsafe { msg_send![super(self), writableTypesForPasteboard: pasteboard] };
            let all = NSMutableArray::new();
            for t in sup.iter() {
                all.addObject(&*t);
            }
            all.addObject(&*NSString::from_str("public.url"));
            all.addObject(&*NSString::from_str("public.utf8-plain-text"));
            Retained::into_super(all)
        }

        #[unsafe(method_id(pasteboardPropertyListForType:))]
        fn property_list_for_type(
            &self,
            pasteboard_type: &NSPasteboardType,
        ) -> Option<Retained<objc2::runtime::AnyObject>> {
            let t = pasteboard_type.to_string();
            if t == "public.url" || t == "public.utf8-plain-text" {
                let s = NSString::from_str(&self.ivars().url_text);
                Some(unsafe { Retained::cast_unchecked(s) })
            } else {
                unsafe { msg_send![super(self), pasteboardPropertyListForType: pasteboard_type] }
            }
        }
    }
);

impl VidMinderPromiseProvider {
    fn new(
        url_text: String,
        file_type: &NSString,
        delegate: &ProtocolObject<dyn NSFilePromiseProviderDelegate>,
    ) -> Retained<Self> {
        let this = Self::alloc().set_ivars(ProviderIvars { url_text });
        unsafe { msg_send![super(this), initWithFileType: file_type, delegate: delegate] }
    }
}

// ---------------------------------------------------------------------------
// Promise delegate: names the file, writes it on drop.

struct DelegateIvars {
    file_name: String,
    app: AppHandle,
    write: WriteFn,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "VidMinderPromiseDelegate"]
    #[ivars = DelegateIvars]
    struct PromiseDelegate;

    unsafe impl NSObjectProtocol for PromiseDelegate {}

    unsafe impl NSFilePromiseProviderDelegate for PromiseDelegate {
        #[unsafe(method_id(filePromiseProvider:fileNameForType:))]
        fn file_name_for_type(
            &self,
            _provider: &NSFilePromiseProvider,
            _file_type: &NSString,
        ) -> Retained<NSString> {
            NSString::from_str(&self.ivars().file_name)
        }

        /// All delegate callbacks run on the main queue (see below), so this
        /// must NOT block: kick off the (possibly long) download+copy and call
        /// the completion handler whenever it finishes.
        #[unsafe(method(filePromiseProvider:writePromiseToURL:completionHandler:))]
        fn write_promise_to_url(
            &self,
            _provider: &NSFilePromiseProvider,
            url: &NSURL,
            completion_handler: &block2::DynBlock<dyn Fn(*mut NSError)>,
        ) {
            let block = SendBlock(completion_handler.copy());
            let app = self.ivars().app.clone();
            let dest = url.path().map(|p| PathBuf::from(p.to_string()));
            let done: Box<dyn FnOnce(Result<(), String>) + Send> = Box::new(move |res| {
                // The handler must be invoked on the main thread.
                let _ = app.run_on_main_thread(move || match res {
                    Ok(()) => block.invoke(std::ptr::null_mut()),
                    Err(msg) => {
                        let err = unsafe {
                            NSError::errorWithDomain_code_userInfo(
                                &NSString::from_str("VidMinder"),
                                1,
                                None,
                            )
                        };
                        eprintln!("file-promise export failed: {msg}");
                        block.invoke(Retained::as_ptr(&err) as *mut NSError);
                    }
                });
            });
            match dest {
                Some(dest) => (self.ivars().write)(dest, done),
                None => done(Err("invalid destination".into())),
            }
        }

        /// Run delegate callbacks on the main queue so this MainThreadOnly
        /// class is always called where it's allowed to live.
        #[unsafe(method_id(operationQueueForFilePromiseProvider:))]
        fn operation_queue(&self, _provider: &NSFilePromiseProvider) -> Retained<NSOperationQueue> {
            NSOperationQueue::mainQueue()
        }
    }
);

impl PromiseDelegate {
    fn new(file_name: String, app: AppHandle, write: WriteFn, mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(DelegateIvars {
            file_name,
            app,
            write,
        });
        unsafe { msg_send![super(this), init] }
    }
}

// ---------------------------------------------------------------------------
// Drag source: copy-only, reports session end.

struct SourceIvars {
    on_end: EndFn,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "VidMinderDragSource"]
    #[ivars = SourceIvars]
    struct DragSource;

    unsafe impl NSObjectProtocol for DragSource {}

    unsafe impl NSDraggingSource for DragSource {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        unsafe fn source_operation_mask(
            &self,
            _session: &NSDraggingSession,
            _context: NSDraggingContext,
        ) -> NSDragOperation {
            NSDragOperation::Copy
        }

        #[unsafe(method(draggingSession:endedAtPoint:operation:))]
        unsafe fn session_ended(
            &self,
            _session: &NSDraggingSession,
            _point: NSPoint,
            operation: NSDragOperation,
        ) {
            (self.ivars().on_end)(operation != NSDragOperation::None);
        }
    }
);

impl DragSource {
    fn new(on_end: EndFn, mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(SourceIvars { on_end });
        unsafe { msg_send![super(this), init] }
    }
}

// ---------------------------------------------------------------------------

/// Start a file-promise drag from the given window. Must be initiated while
/// the user's drag gesture is in progress (mouse button down).
pub fn start_promise_drag(
    app: &AppHandle,
    window: tauri::Window,
    opts: PromiseDragOptions,
    write: WriteFn,
    on_end: EndFn,
) -> Result<(), String> {
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = start_on_main_thread(&app2, &window, opts, write, on_end) {
            eprintln!("promise drag failed to start: {e}");
        }
    })
    .map_err(|e| format!("main thread dispatch: {e}"))
}

fn start_on_main_thread(
    app: &AppHandle,
    window: &tauri::Window,
    opts: PromiseDragOptions,
    write: WriteFn,
    on_end: EndFn,
) -> Result<(), String> {
    let Ok(RawWindowHandle::AppKit(w)) = window.window_handle().map(|h| h.as_raw()) else {
        return Err("unsupported window handle".into());
    };
    unsafe {
        let mtm = MainThreadMarker::new_unchecked();
        let ns_view = &*(w.ns_view.as_ptr() as *const NSView);
        let ns_window = ns_view.window().ok_or("no NSWindow")?;
        let content_view = ns_window.contentView().ok_or("no contentView")?;

        let current_position: NSPoint = ns_window.mouseLocationOutsideOfEventStream();

        let img_data = NSData::from_vec(opts.png);
        let img = NSImage::initWithData(NSImage::alloc(), &img_data)
            .ok_or("couldn't decode drag image")?;
        let image_size: NSSize = img.size();
        let image_rect = NSRect::new(
            NSPoint::new(
                current_position.x - image_size.width / 2.,
                current_position.y - image_size.height / 2.,
            ),
            image_size,
        );

        let delegate = PromiseDelegate::new(opts.file_name, app.clone(), write, mtm);
        let provider = VidMinderPromiseProvider::new(
            opts.url_text,
            &NSString::from_str(&opts.file_type_uti),
            ProtocolObject::from_ref(&*delegate),
        );
        // The provider's `delegate` property is WEAK; anchor the delegate to
        // the provider's strong `userInfo` so it lives as long as the promise.
        provider.setUserInfo(Some(&*delegate));

        let drag_item = NSDraggingItem::initWithPasteboardWriter(
            NSDraggingItem::alloc(),
            ProtocolObject::from_ref(&*provider),
        );
        drag_item.setDraggingFrame_contents(image_rect, Some(&*img));
        let dragging_items = NSMutableArray::new();
        dragging_items.addObject(&*drag_item);

        let current_event = NSApp(mtm).currentEvent();
        let timestamp = current_event.map(|e| e.timestamp()).unwrap_or(0.0);
        let window_number = ns_window.windowNumber();

        let drag_event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::LeftMouseDragged,
            current_position,
            NSEventModifierFlags::empty(),
            timestamp,
            window_number,
            None,
            0,
            1,
            1.0,
        )
        .ok_or("couldn't create drag event")?;

        let source = DragSource::new(on_end, mtm);
        let _session = content_view.beginDraggingSessionWithItems_event_source(
            &dragging_items,
            &drag_event,
            ProtocolObject::from_ref(&*source),
        );
    }
    Ok(())
}

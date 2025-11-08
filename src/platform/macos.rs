use crate::models::ScreenshotResponse;
use crate::{Error, Result};
use image;
use log::{debug, info, error};
use tauri::Runtime;

// Import shared functionality
use crate::desktop::{ScreenshotContext, create_success_response};
use crate::platform::shared::{get_window_title, handle_screenshot_task};
use crate::shared::ScreenshotParams;
use crate::tools::take_screenshot::process_image;

// macOS-specific implementation for taking screenshots
pub async fn take_screenshot<R: Runtime>(
    params: ScreenshotParams,
    window_context: ScreenshotContext<R>,
) -> Result<ScreenshotResponse> {
    // Clone necessary parameters for use in the closure
    let params_clone = params.clone();
    let window_clone = window_context.window.clone();
    let window_label = params
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());
    
    // Get application name from params or use a default
    let application_name = params.application_name.clone().unwrap_or_else(|| "".to_string());

    handle_screenshot_task(move || {
        // Get the window title to help identify the right window
        let window_title = get_window_title(&window_clone)?;
        
        info!("[TAURI-MCP] Looking for window with title: {} (label: {})", window_title, window_label);
        
        // Get all windows using xcap - do this only once
        let xcap_windows = match xcap::Window::all() {
            Ok(windows) => windows,
            Err(e) => return Err(Error::WindowOperationFailed(format!("Failed to get window list: {}", e))),
        };
        
        info!("[TAURI-MCP] Found {} windows through xcap", xcap_windows.len());
        
        // Find the target window using optimized search strategy
        if let Some(window) = find_window(&xcap_windows, &window_title, &application_name) {
            // Capture image directly from the window
            let image = match window.capture_image() {
                Ok(img) => img,
                Err(e) => return Err(Error::WindowOperationFailed(format!("Failed to capture window image: {}", e))),
            };
            
            info!("[TAURI-MCP] Successfully captured window image: {}x{}", 
                  image.width(), image.height());
            
            // Convert to DynamicImage for further processing
            let dynamic_image = image::DynamicImage::ImageRgba8(image);
            
            // Process the image
            match process_image(dynamic_image, &params_clone) {
                Ok(data_url) => Ok(create_success_response(data_url)),
                Err(e) => Err(e),
            }
        } else {
            // No window found
            Err(Error::WindowOperationFailed("Window not found using any detection method. Please ensure the window is visible and not minimized.".to_string()))
        }
    }).await
}

// Helper function to find the window in the xcap window list - optimized version
fn find_window(xcap_windows: &[xcap::Window], window_title: &str, application_name: &str) -> Option<xcap::Window> {
    let application_name_lower = application_name.to_lowercase();

    debug!(
        "[TAURI-MCP] Searching for window with title: '{}' (case-insensitive)",
        window_title
    );

    // Debug all windows to help with troubleshooting
    debug!("[TAURI-MCP] ============= ALL WINDOWS =============");
    for window in xcap_windows {
        if let Ok(is_minimized) = window.is_minimized() {
            if !is_minimized {
                if let (Ok(title), Ok(app_name)) = (window.title(), window.app_name()) {
                    debug!(
                        "[TAURI-MCP] Window: title='{}', app_name='{}'",
                        title,
                        app_name
                    );
                }
            }
        }
    }
    debug!("[TAURI-MCP] ======================================");

    // Step 1: First pass - direct application name match (highest priority and fastest check)
    if !application_name_lower.is_empty() {
        for window in xcap_windows {
            if let Ok(is_minimized) = window.is_minimized() {
                if is_minimized {
                    continue;
                }
            }

            if let Ok(app_name) = window.app_name() {
                let app_name_lower = app_name.to_lowercase();

                // Direct match for application name - highest priority
                if app_name_lower.contains(&application_name_lower) {
                    info!(
                        "[TAURI-MCP] Found window by app name: '{}'",
                        app_name
                    );
                    return Some(window.clone());
                }
            }
        }
    }

    // Step 2: Try matching by window title if app name search didn't work
    let window_title_lower = window_title.to_lowercase();
    debug!("[TAURI-MCP] Step 2: Searching by title, looking for: '{}'", window_title_lower);

    for window in xcap_windows {
        // Skip if we can't check minimized status
        if let Ok(is_minimized) = window.is_minimized() {
            if is_minimized {
                continue;
            }
        } else {
            // If is_minimized() fails, skip this window
            continue;
        }

        if let Ok(title) = window.title() {
            let title_lower = title.to_lowercase();
            debug!("[TAURI-MCP] Checking title: '{}' vs '{}'", title_lower, window_title_lower);

            // Match by title
            if title_lower == window_title_lower || title_lower.contains(&window_title_lower) {
                info!(
                    "[TAURI-MCP] Found window by title match: '{}'",
                    title
                );
                return Some(window.clone());
            }
        }
    }

    debug!("[TAURI-MCP] Step 2 complete: No title match found");

    error!(
        "[TAURI-MCP] No matching window found for '{}'",
        window_title
    );
    None
}

// Add any other macOS-specific functionality here

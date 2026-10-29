# macos-15

- structure: pass
- open_launch: pass
- open_stays_alive: pass
- direct_launch: pass
- window_found: pass
- bottom_right: pass
- transparent: pass
- pet_visible: pass
- bubble: pass
- direct_stays_alive: pass
- bubble_hides: pass
- head_click: fail
- head_returns_idle: fail
- bottom_spank: pass
- spank_returns_idle: fail
- feed: pass
- feed_returns_idle: fail
- sleep: fail
- wake: fail
- dance: fail
- dance_ends: fail
- more_menu: pass
- toolbar_hide: pass
- right_menu: pass
- drag: fail
- run_loop: pass
- quit: pass

## failures
- head_click: FAIL log
- head_returns_idle: FAIL state timer
- spank_returns_idle: FAIL angry timer
- feed_returns_idle: FAIL state timer after feed
- sleep: FAIL toolbar 睡觉
- wake: FAIL toolbar 醒来
- dance: FAIL double-click
- dance_ends: FAIL dance timer
- drag: FAIL moved=False

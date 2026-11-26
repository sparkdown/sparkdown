// WebDriver script body: true when the active tab shows its unsaved dot.
// Every tab has a dot element; a tab without unsaved changes keeps it
// hidden (display: none), so only a dot that is displayed counts.
const dot = document.querySelector('.tab.active .tab-modified-dot');
return !!dot && getComputedStyle(dot).display !== 'none';

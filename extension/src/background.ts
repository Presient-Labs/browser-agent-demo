// Minimal service worker: only wires the toolbar button to the side panel. No network, no storage.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

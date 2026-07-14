chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content/content.js'],
    });
  } catch (error) {
    // Restricted pages cannot be scripted. Keep the failure local and non-sensitive.
    console.warn('PiP Zoom could not start on this page.', error);
  }
});

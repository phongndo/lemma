const { contextBridge, ipcRenderer } = require("electron");

// A narrow bridge: the page cannot choose a process, command, or IPC channel.
contextBridge.exposeInMainWorld("lemmaDesktop", {
  ownsHost: process.argv.includes("--lemma-owns-host"),
  reload: () => ipcRenderer.invoke("lemma:reload"),
  // The window's controls on Windows and Linux take the page's colors: its background and muted text, as `#rrggbb`.
  titleBar: {
    setColors: (background, symbols) => ipcRenderer.send("lemma:title-bar", String(background), String(symbols)),
  },
  // The profile's window can open another profile's, in a window of its own (`lemma:open-profile`).
  openProfile: (name) => ipcRenderer.invoke("lemma:open-profile", String(name)),
  // A profile the page deleted: its windows close, and what its pages kept goes (`lemma:profile-removed`).
  profileRemoved: (name) => ipcRenderer.invoke("lemma:profile-removed", String(name)),
  // The browser view's pages (`src/browser.ts`), in the window's profile's partition.
  browser: {
    partition: process.argv.find((arg) => arg.startsWith("--lemma-browser-partition="))?.slice("--lemma-browser-partition=".length) ?? "persist:lemma-browser",
    forwardKeys: (bindings) => ipcRenderer.send("lemma:browser-keys", Array.isArray(bindings) ? bindings.filter((binding) => typeof binding === "string") : []),
    onOpen: (listener) => {
      const heard = (_event, page, url, background) => listener(page, url, background);
      ipcRenderer.on("lemma:browser-open", heard);
      return () => ipcRenderer.removeListener("lemma:browser-open", heard);
    },
  },
});

// A shortcut of the app's pressed in a page: the app hears it as pressed where focus is (the page's element).
ipcRenderer.on("lemma:browser-key", (_event, input) => {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: input.key,
      code: input.code,
      metaKey: input.meta,
      ctrlKey: input.control,
      altKey: input.alt,
      shiftKey: input.shift,
      bubbles: true,
      cancelable: true,
    }),
  );
});

const { contextBridge, ipcRenderer } = require("electron");

// A narrow bridge: the page cannot choose a process, command, or IPC channel.
contextBridge.exposeInMainWorld("lemmaDesktop", {
  ownsHost: process.argv.includes("--lemma-owns-host"),
  reload: () => ipcRenderer.invoke("lemma:reload"),
});

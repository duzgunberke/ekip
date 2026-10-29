// Moved to ./ops/doctor.js. This forwarder keeps processes started before the move (a long worker,
// an old pane) working when they load the module lazily; it goes away in a later release.
export * from "./ops/doctor.js";

// An imported recording is bundled into app.js as a data URL (see the loader in build.mjs):
// a separate file would not load from file://, where demo mode runs.
declare module '*.mp3' {
  const url: string;
  export default url;
}

/*
 * How a web plugin imports an asset, as the web app's bundler serves it: a stylesheet as text (`./x.css?inline`, its
 * `styles`), a file's address (`?url`), or a file's text (`?raw`). A web plugin's package includes this file in its
 * tsconfig.
 */
declare module "*?inline" {
  const text: string;
  export default text;
}
declare module "*?url" {
  const url: string;
  export default url;
}
declare module "*?raw" {
  const text: string;
  export default text;
}

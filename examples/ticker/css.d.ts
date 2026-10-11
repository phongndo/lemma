// The host compiles a web half's stylesheet import to its text, for `styles`.
declare module "*.css" {
  const text: string;
  export default text;
}

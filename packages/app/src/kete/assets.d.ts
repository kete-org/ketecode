// Vite's `?url` import suffix (env.d.ts declares *.png/*.mp4 but not this; the app has no
// `vite/client` types).

declare module "*?url" {
  const src: string
  export default src
}

/**
 * The supported Vite browser baseline has native IntersectionObserver support.
 * @react-hook/intersection-observer already returns a safe empty result when the API is absent, so
 * the deprecated pre-2019 global polyfill does not contribute bytes to the modern browser build.
 */
export {};

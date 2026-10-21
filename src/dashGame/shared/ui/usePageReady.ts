/** Dashboard host has no router preloader. The player hook is a no-op here. */
export function usePageReady() {
  return {
    ready: true,
    markReady: () => {},
    isWaiting: false,
  };
}

export function useMarkPageReady(_isReady: boolean) {}

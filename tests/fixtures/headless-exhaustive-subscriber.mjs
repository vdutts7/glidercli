export const apiVersion = "headless-subscriber/v1";

const DEFAULT_URL =
  "data:text/html,<title>Glider exhaustive smoke</title><form><input name='probe' value='captured' required></form><script>console.log('captured')%0Anew Worker(URL.createObjectURL(new Blob([\"console.log('worker captured')\"],{type:'text/javascript'})))%0A//%23 sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInNtb2tlLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiIifQ==</script>";

export async function configure({ env }) {
  const captureMode = env.GLIDER_SMOKE_CAPTURE_MODE || "exhaustive";
  return {
    outputDir: "/invalid/runtime-option-must-override",
    captureMode,
    requireCompleteCapture: captureMode === "exhaustive",
    captureAdvertisedSourceMaps: captureMode === "exhaustive",
    captureProxyTraffic:
      captureMode === "exhaustive" && env.GLIDER_SMOKE_CAPTURE_PROXY === "1",
    proxyStartupTimeoutMs: Number(
      env.GLIDER_SMOKE_PROXY_STARTUP_TIMEOUT_MS || 30_000,
    ),
    subscriberConfig: {
      url: env.GLIDER_SMOKE_URL || DEFAULT_URL,
    },
  };
}

export async function run(ctx, options) {
  await ctx.navigate(options.url);
  if (ctx.captureMode === "exhaustive") await ctx.checkpoint("01-smoke");
  return {
    href: await ctx.evaluate("location.href"),
    captureMode: ctx.captureMode,
  };
}

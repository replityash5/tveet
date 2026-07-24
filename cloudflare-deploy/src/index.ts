import { Container, getRandom } from "@cloudflare/containers";

export class TweetVideoContainer extends Container {
  // Must match the port server.js listens on (see ../server.js -> PORT)
  defaultPort = 3000;
  // Irrelevant in practice once minimum_instances:1 is set in wrangler.jsonc,
  // since the container is never allowed to scale to zero — but harmless to leave.
  sleepAfter = "1h";
}

interface Env {
  TWEET_CONTAINER: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const instance = await getRandom(env.TWEET_CONTAINER, 1);
    return instance.fetch(request);
  },
};

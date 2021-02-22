import { Application, Router, HttpError, Status, send } from "https://deno.land/x/oak@v6.2.0/mod.ts";
import { viewEngine, engineFactory, adapterFactory } from "https://deno.land/x/view_engine@v1.4.5/mod.ts";

const app = new Application();
const router = new Router();
const ejsEngine = await engineFactory.getEjsEngine();
const oakAdapter = await adapterFactory.getOakAdapter();

app.use(viewEngine(oakAdapter, ejsEngine));

// Error Handling
app.use(async (context, next) => {
  try {
    await next();
  } catch (e) {
    if (e instanceof HttpError) {
      context.response.status = e.status as any;
      if (e.expose) {
        context.response.body = `<!doctype html><html><body><h1>${e.status} - ${e.message}</h1></body></html>`;
      } else {
        context.response.body = `<!doctype html><html><body><h1>${e.status} - ${Status[e.status]}</h1></body></html>`;
      }
    } else if (e instanceof Error) {
      context.response.status = 500;
      context.response.body = `<!doctype html><html><body><h1>500 - Internal Server Error</h1></body></html>`;
      console.log("Unhandled Error:", e.message);
      console.log(e.stack);
    }
  }
});

// Static serving
app.use(async (ctx) => {
  await ctx.send({
    root: `${Deno.cwd()}/public`,
    index: 'index.html',
  });
});

app.addEventListener('listen', ({hostname, port}) => {
  console.log(`Serving ${Deno.cwd()}`);
  console.log(`Start listening on ${hostname}:${port}`);
})

//await app.listen({hostname: "0.0.0.0", port: 8000 });
await app.listen({hostname: "0.0.0.0", port: 4430, secure: true, certFile: 'localhost.pem', keyFile: 'localhost-key.pem' });

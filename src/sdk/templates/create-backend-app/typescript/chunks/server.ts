import { createBackendApp } from "./app.js";

const port = Number(process.env.PORT ?? {{devPort}});

createBackendApp().then((app) => {
  const server = app.listen(port, () => {
    console.log(`{{appName}} listening on http://localhost:${port}`);
  });
  const shutdown = () => {
    server.close(() => {
      console.log("{{appName}} stopped");
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
});

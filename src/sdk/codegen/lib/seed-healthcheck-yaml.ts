const HEALTH_SERVICE_NAME = "HealthCheckService";
const HEALTH_SERVICE_MODULE = "./services/custom/health-check-service";
const HEALTH_ROUTE_PATH = "/api/health";

function findHealthServiceIndex(services: unknown[]): number {
  for (let i = 0; i < services.length; i++) {
    const entry = services[i];
    if (!entry || typeof entry !== "object") continue;
    if ((entry as { name?: unknown }).name === HEALTH_SERVICE_NAME) return i;
  }
  return -1;
}

function findHealthRouteIndex(routes: unknown[]): number {
  for (let i = 0; i < routes.length; i++) {
    const entry = routes[i];
    if (!entry || typeof entry !== "object") continue;
    for (const def of Object.values(entry as Record<string, unknown>)) {
      if (
        def &&
        typeof def === "object" &&
        (def as { path?: unknown }).path === HEALTH_ROUTE_PATH
      ) {
        return i;
      }
    }
  }
  return -1;
}

export function ensureHealthServiceFirst(servicesDoc: unknown) {
  const seed = { name: HEALTH_SERVICE_NAME, module: HEALTH_SERVICE_MODULE };
  if (!servicesDoc || typeof servicesDoc !== "object") {
    return { doc: { services: [seed] }, mutated: true };
  }
  const doc = servicesDoc as Record<string, unknown>;
  const services = Array.isArray(doc.services) ? doc.services : [];
  const idx = findHealthServiceIndex(services);
  if (idx === 0) {
    return { doc: { ...doc, services: [...services] }, mutated: false };
  }
  if (idx > 0) {
    const next = [
      services[idx],
      ...services.slice(0, idx),
      ...services.slice(idx + 1),
    ];
    return { doc: { ...doc, services: next }, mutated: true };
  }
  return {
    doc: { ...doc, services: [seed, ...services] },
    mutated: true,
  };
}

export function ensureHealthRouteFirst(routesDoc: unknown) {
  const seed = {
    getHealth: {
      method: "GET",
      path: HEALTH_ROUTE_PATH,
      service: HEALTH_SERVICE_NAME,
      serviceMethod: "check",
    },
  };
  if (!routesDoc || typeof routesDoc !== "object") {
    return { doc: { routes: [seed] }, mutated: true };
  }
  const doc = routesDoc as Record<string, unknown>;
  const routes = Array.isArray(doc.routes) ? doc.routes : [];
  const idx = findHealthRouteIndex(routes);
  if (idx === 0) {
    return { doc: { ...doc, routes: [...routes] }, mutated: false };
  }
  if (idx > 0) {
    const next = [
      routes[idx],
      ...routes.slice(0, idx),
      ...routes.slice(idx + 1),
    ];
    return { doc: { ...doc, routes: next }, mutated: true };
  }
  return {
    doc: { ...doc, routes: [seed, ...routes] },
    mutated: true,
  };
}

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { PrismaClient } from "@prisma/client";

/**
 * Single shared PrismaClient instance attached to the Fastify instance.
 *
 * fastify-plugin is used so the decorator is registered on the root instance
 * and stays visible to encapsulated child contexts (routes, future plugins).
 *
 * The database URL comes from the validated AppConfig, not directly from
 * process.env — the config object is the single source of truth for where
 * this process writes (and lets integration tests target a dedicated DB).
 *
 * Fastify owns the lifecycle: `onClose` disconnects the client during graceful
 * shutdown, so the process never leaks open database connections.
 */
declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export interface PrismaPluginOptions {
  databaseUrl?: string;
}

export default fp(async function prismaPlugin(app: FastifyInstance, options: PrismaPluginOptions) {
  const prisma = options.databaseUrl
    ? new PrismaClient({ datasourceUrl: options.databaseUrl })
    : new PrismaClient();

  app.decorate("prisma", prisma);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});

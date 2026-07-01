import type { FastifyPluginAsync } from "fastify";
import { DocCreateInputSchema, DocUpdateInputSchema } from "@loopeng/shared";
import { createDoc, getDoc, getDocVersions, getTemplate, listDocs, updateDoc } from "@loopeng/doc-engine";

export const docRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/docs/templates/:docType", async (request, reply) => {
    const { docType } = request.params as { docType: string };
    if (docType !== "adr" && docType !== "rfc" && docType !== "skill") {
      reply.status(400).send({ error: "invalid_template_type" });
      return;
    }
    const content = await getTemplate(docType);
    return { docType, content };
  });

  fastify.get("/docs", async (request) => {
    const { docType } = request.query as { docType?: string };
    return listDocs(docType ? { docType } : undefined);
  });

  fastify.post("/docs", async (request, reply) => {
    const input = DocCreateInputSchema.parse(request.body);
    const doc = await createDoc(input);
    reply.status(201).send(doc);
  });

  fastify.get("/docs/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const doc = await getDoc(slug);
    if (!doc) {
      reply.status(404).send({ error: "not_found" });
      return;
    }
    return doc;
  });

  fastify.get("/docs/:slug/versions", async (request) => {
    const { slug } = request.params as { slug: string };
    return getDocVersions(slug);
  });

  fastify.post("/docs/:slug/versions", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const input = DocUpdateInputSchema.parse(request.body);
    const doc = await updateDoc(slug, input);
    reply.status(201).send(doc);
  });
};

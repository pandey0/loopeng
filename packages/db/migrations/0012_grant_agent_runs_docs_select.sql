-- get_doc (packages/doc-engine/src/index.ts, exposed to agents as the
-- get_doc MCP tool) is a legitimate read-only need for the same sub-agent
-- MCP server process migration 0011 scoped down to loopeng_agent_runs --
-- it only ever SELECTs docs by slug (the doc body itself comes from a git
-- read, not this table). Read-only access can't reproduce the incident
-- (card 438646e5) this role exists to prevent, so it's safe to extend
-- narrowly rather than routing get_doc through the HTTP API.
GRANT SELECT ON "docs" TO "loopeng_agent_runs";

import { Badge, Flex, Heading } from "@radix-ui/themes";
import type { ReactNode } from "react";

export type LiteNodeStatus = "locked" | "ready" | "running" | "review" | "approved" | "failed";

export type LiteNodeModel = {
  id: string;
  title: string;
  status: LiteNodeStatus;
  wide?: boolean;
  body: ReactNode;
};

const STATUS_LABEL: Record<LiteNodeStatus, string> = {
  locked: "Waiting",
  ready: "Ready",
  running: "Working",
  review: "Your turn",
  approved: "Done",
  failed: "Stopped",
};

const STATUS_COLOR: Record<LiteNodeStatus, "gray" | "blue" | "amber" | "green" | "red"> = {
  locked: "gray",
  ready: "blue",
  running: "blue",
  review: "amber",
  approved: "green",
  failed: "red",
};

export function LiteCanvas({ nodes }: { nodes: LiteNodeModel[] }) {
  return (
    <div className="lite-flow-board">
      {nodes.map((node, index) => {
        const previous = index > 0 ? nodes[index - 1] : null;
        const wireLive =
          previous?.status === "approved" ||
          previous?.status === "review" ||
          node.status === "running" ||
          node.status === "review" ||
          node.status === "approved";
        return (
          <div className="lite-flow-node-wrap" key={node.id}>
            {index > 0 ? (
              <div className={wireLive ? "lite-flow-wire is-live" : "lite-flow-wire"} />
            ) : null}
            <section
              className={[
                "lite-flow-node",
                `is-${node.status}`,
                node.wide ? "is-wide" : "",
                node.status === "review" || node.status === "running" ? "is-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <Flex align="center" justify="between" gap="2">
                <Heading size="3">{node.title}</Heading>
                <Badge color={STATUS_COLOR[node.status]} variant="soft">
                  {STATUS_LABEL[node.status]}
                </Badge>
              </Flex>
              {node.body}
            </section>
          </div>
        );
      })}
    </div>
  );
}

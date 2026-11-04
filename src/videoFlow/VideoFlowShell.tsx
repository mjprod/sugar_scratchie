import { ExternalLink, LoaderCircle, Tags, UserRound } from "lucide-react";
import { Box, Button, Flex, Heading, Text } from "@radix-ui/themes";
import type { ReactNode } from "react";
import { hrefWithModel, readCurrentModelId } from "../shared/currentModel";
import { iconProps } from "./ui";

type VideoFlowShellProps = {
  title: string;
  subtitle: string;
  active: "hub" | "designer" | "run" | "lite" | "picture" | "dress";
  /** Girl on the open card. Dress opens her gallery. */
  dressModelId?: string;
  error?: string;
  onRefresh?: () => void;
  children: ReactNode;
};

export function VideoFlowShell({
  title,
  subtitle,
  active,
  dressModelId,
  error,
  onRefresh,
  children,
}: VideoFlowShellProps) {
  const girl = dressModelId?.trim() || readCurrentModelId();
  const dressHref = hrefWithModel("/dashboard/video-flow/dress", girl);
  const runHref = hrefWithModel("/dashboard/video-flow/run", girl);
  const modelsHref = hrefWithModel("/dashboard/models", girl);
  return (
    <div className="video-flow-page">
      <header className="video-flow-header">
        <Flex
          align={{ initial: "start", md: "center" }}
          direction={{ initial: "column", md: "row" }}
          gap="4"
          justify="between"
        >
          <Box>
            <Text color="red" size="2" weight="bold">
              {active === "picture" ? "Picture Flow" : "Video Flow"}
            </Text>
            <Heading as="h1" size="7">
              {title}
            </Heading>
            <Text color="gray" size="2">
              {subtitle}
            </Text>
          </Box>
          <Flex align="center" gap="2" wrap="wrap">
            <nav className="video-flow-nav">
              <a className={active === "run" ? "is-active" : ""} href={runHref}>
                Run
              </a>
              <a className={active === "lite" ? "is-active" : ""} href="/dashboard/video-flow/lite">
                Lite
              </a>
              <a
                className={active === "designer" ? "is-active" : ""}
                href="/dashboard/video-flow/designer"
              >
                Design
              </a>
              <a
                className={active === "picture" ? "is-active" : ""}
                href="/dashboard/picture-flow"
              >
                Picture
              </a>
              <a
                className={active === "dress" ? "is-active" : ""}
                href={dressHref}
              >
                Dress
              </a>
            </nav>
            <Button asChild color="gray" variant="soft">
              <a href={modelsHref}>
                <UserRound {...iconProps} />
                Models
              </a>
            </Button>
            <Button asChild color="gray" variant="soft">
              <a href="/dashboard/packs">Packs</a>
            </Button>
            <Button asChild color="gray" variant="soft">
              <a href="/dashboard/themes">
                <Tags {...iconProps} />
                Themes
              </a>
            </Button>
            <Button asChild color="gray" variant="soft">
              <a href="/dashboard/ai-models">AI models</a>
            </Button>
            <Button asChild color="gray" variant="soft">
              <a href="/symbols">Symbols</a>
            </Button>
            <Button asChild color="gray" variant="soft">
              <a href="/dashboard">
                <ExternalLink {...iconProps} />
                Dashboard
              </a>
            </Button>
            {onRefresh ? (
              <Button color="gray" variant="soft" onClick={onRefresh}>
                <LoaderCircle {...iconProps} />
                Refresh
              </Button>
            ) : null}
          </Flex>
        </Flex>
        {error ? (
          <Text color="red" size="2" mt="3">
            {error}
          </Text>
        ) : null}
      </header>
      <main className="video-flow-main">{children}</main>
    </div>
  );
}

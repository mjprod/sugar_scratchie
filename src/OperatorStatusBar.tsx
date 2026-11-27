import { LoaderCircle, SlidersHorizontal, Video, Workflow } from "lucide-react";
import { Box, Button, Card, Flex, Grid, Heading, Text } from "@radix-ui/themes";
import { useEffect, useState } from "react";
import { api } from "./shared/api";
import { hrefWithModel, readSavedModelId } from "./shared/currentModel";

type JobInfo = {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
};

type HealthResponse = {
  ok: boolean;
  xai_key_loaded: boolean;
  ffmpeg_available: boolean;
};

const iconProps = { "aria-hidden": true, size: 16, strokeWidth: 2.25 } as const;

export function OperatorStatusBar() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [activeJobs, setActiveJobs] = useState(0);
  const [error, setError] = useState("");

  async function refreshHealth() {
    setHealth(await api<HealthResponse>("/api/health"));
  }

  async function refreshJobs() {
    const data = await api<{ jobs: JobInfo[] }>("/api/jobs");
    setActiveJobs(
      data.jobs.filter((job) => job.status === "queued" || job.status === "running").length,
    );
  }

  function refresh() {
    setError("");
    refreshHealth().catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
    refreshJobs().catch(() => undefined);
  }

  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => {
      refreshJobs().catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <Flex direction="column" gap="3">
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="4">Quick links</Heading>
          <Flex gap="2" wrap="wrap">
            <Button color="gray" variant="soft" onClick={refresh}>
              <LoaderCircle {...iconProps} />
              Refresh
            </Button>
            <Button asChild variant="soft">
              <a href={hrefWithModel("/dashboard/video-flow/dress", readSavedModelId())}>Dress</a>
            </Button>
            <Button asChild variant="soft">
              <a href="/video-transition">
                <SlidersHorizontal {...iconProps} />
                Transition lab
              </a>
            </Button>
          </Flex>
        </Flex>
      </Card>
      {error ? (
        <Text color="red" size="2">
          {error}
        </Text>
      ) : null}
      <Grid columns={{ initial: "1", sm: "2", md: "4" }} gap="3">
        <Card>
          <Flex align="center" gap="3">
            <SlidersHorizontal {...iconProps} />
            <Box>
              <Text as="div" size="2" weight="bold">
                API status
              </Text>
              <Text as="div" color={health?.ok ? "green" : "gray"} size="2">
                {health?.ok ? "Connected" : "Checking"}
              </Text>
            </Box>
          </Flex>
        </Card>
        <Card>
          <Flex align="center" gap="3">
            <Workflow {...iconProps} />
            <Box>
              <Text as="div" size="2" weight="bold">
                API key
              </Text>
              <Text as="div" color={health?.xai_key_loaded ? "green" : "orange"} size="2">
                {health?.xai_key_loaded ? "API key loaded" : "API key missing"}
              </Text>
            </Box>
          </Flex>
        </Card>
        <Card>
          <Flex align="center" gap="3">
            <SlidersHorizontal {...iconProps} />
            <Box>
              <Text as="div" size="2" weight="bold">
                Video tools
              </Text>
              <Text as="div" color={health?.ffmpeg_available ? "green" : "orange"} size="2">
                {health?.ffmpeg_available ? "ffmpeg ready" : "ffmpeg missing"}
              </Text>
            </Box>
          </Flex>
        </Card>
        <Card>
          <Flex align="center" gap="3">
            <Video {...iconProps} />
            <Box>
              <Text as="div" size="2" weight="bold">
                Active jobs
              </Text>
              <Text as="div" color="gray" size="2">
                {activeJobs} queued or running
              </Text>
            </Box>
          </Flex>
        </Card>
      </Grid>
    </Flex>
  );
}

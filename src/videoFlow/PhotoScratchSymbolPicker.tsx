import { Button, Flex, Text } from "@radix-ui/themes";
import { useEffect, useRef, useState } from "react";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  drawMeshLines,
  parseTrackedMesh,
  randomSymbolPoints,
  sampleMeshUvToWorld,
  sampleTrackedMesh,
  SYMBOL_POINT_COUNT,
  trackedWorldToUv,
  type SymbolPoint,
  type TrackedMesh,
  type Vec2,
} from "../meshGeometry";
import {
  fetchPhotoScratchSlotSymbols,
  savePhotoScratchSlotSymbols,
} from "../shared/models";

type PhotoScratchSymbolPickerProps = {
  cardId: string;
  slotId: string;
  imageSrc: string;
  meshUrl: string;
  onSaved: () => void;
  onError: (message: string) => void;
};

function canvasPointFromEvent(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): Vec2 | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * CANVAS_WIDTH,
    y: ((clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
  };
}

/** Place 12 UV symbol anchors on a photo-scratch still mesh (image backdrop). */
export function PhotoScratchSymbolPicker({
  cardId,
  slotId,
  imageSrc,
  meshUrl,
  onSaved,
  onError,
}: PhotoScratchSymbolPickerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const meshRef = useRef<TrackedMesh | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const [points, setPoints] = useState<SymbolPoint[]>([]);
  const [mesh, setMesh] = useState<TrackedMesh | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showMesh, setShowMesh] = useState(true);
  const [showPoints, setShowPoints] = useState(true);

  // Load once per slot/mesh — do not re-fetch when parent re-renders.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    onErrorRef.current("");
    void (async () => {
      try {
        const [meshResponse, pointsResponse] = await Promise.all([
          fetch(meshUrl, { cache: "no-store" }),
          fetchPhotoScratchSlotSymbols(cardId, slotId),
        ]);
        if (!meshResponse.ok) {
          throw new Error(`Mesh not found (${meshResponse.status})`);
        }
        const meshData = parseTrackedMesh(await meshResponse.json());
        if (!meshData) {
          throw new Error("Invalid mesh JSON");
        }
        if (cancelled) return;
        meshRef.current = meshData;
        setMesh(meshData);
        if (pointsResponse.points.length === 0) {
          const sample = sampleTrackedMesh(meshData, 0);
          const suggested = randomSymbolPoints(
            sample,
            SYMBOL_POINT_COUNT,
            meshData.garment,
          );
          setPoints(suggested.length === SYMBOL_POINT_COUNT ? suggested : []);
        } else {
          setPoints(pointsResponse.points);
        }
      } catch (caught) {
        if (cancelled) return;
        meshRef.current = null;
        setMesh(null);
        setPoints([]);
        onErrorRef.current(
          caught instanceof Error ? caught.message : String(caught),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cardId, meshUrl, slotId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const meshNow = meshRef.current;
    if (!canvas || !meshNow) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sample = sampleTrackedMesh(meshNow, 0);
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    if (showMesh) {
      drawMeshLines(ctx, sample);
    }
    if (showPoints) {
      for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        const world = sampleMeshUvToWorld(sample, point.u, point.v);
        ctx.beginPath();
        ctx.arc(world.x, world.y, 14, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 217, 120, 0.9)";
        ctx.fill();
        ctx.strokeStyle = "rgba(20, 18, 16, 0.85)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#141210";
        ctx.font = "bold 12px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(index + 1), world.x, world.y);
      }
    }
  }, [points, showMesh, showPoints, mesh, loading]);

  function handleCanvasClick(event: React.MouseEvent<HTMLCanvasElement>) {
    if (points.length >= SYMBOL_POINT_COUNT) return;
    const canvas = canvasRef.current;
    const meshNow = meshRef.current;
    if (!canvas || !meshNow) return;
    const world = canvasPointFromEvent(canvas, event.clientX, event.clientY);
    if (!world) return;
    const sample = sampleTrackedMesh(meshNow, 0);
    const uv = trackedWorldToUv(sample, world);
    if (!uv) return;
    setPoints((current) => [...current, { u: uv.x, v: uv.y }]);
  }

  function handleGenerateRandom() {
    const meshNow = meshRef.current;
    if (!meshNow) return;
    const sample = sampleTrackedMesh(meshNow, 0);
    const generated = randomSymbolPoints(sample, SYMBOL_POINT_COUNT, meshNow.garment);
    if (generated.length !== SYMBOL_POINT_COUNT) {
      onError("No garment cells to place points in — recreate mesh first.");
      return;
    }
    onError("");
    setPoints(generated);
  }

  async function handleSave() {
    if (points.length !== SYMBOL_POINT_COUNT) return;
    setSaving(true);
    onError("");
    try {
      await savePhotoScratchSlotSymbols(cardId, slotId, points);
      onSaved();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <Text size="2">Loading mesh…</Text>;
  }

  if (!mesh) {
    return (
      <Text color="red" size="2">
        Mesh unavailable — create mesh first.
      </Text>
    );
  }

  return (
    <Flex direction="column" gap="3">
      <Text color="gray" size="2">
        Place {SYMBOL_POINT_COUNT} symbols on this photo card. Click to add, or generate
        random points on the garment, then save.
      </Text>

      <div className="symbol-picker-stage">
        <img
          alt="Photo scratch layer"
          className="symbol-picker-video"
          src={imageSrc}
        />
        <canvas
          ref={canvasRef}
          className="symbol-picker-canvas"
          height={CANVAS_HEIGHT}
          width={CANVAS_WIDTH}
          onClick={handleCanvasClick}
        />
      </div>

      <Flex gap="2" wrap="wrap">
        <Button type="button" onClick={handleGenerateRandom}>
          Generate random 12
        </Button>
        <Button type="button" variant="soft" onClick={() => setShowMesh((v) => !v)}>
          {showMesh ? "Hide mesh" : "Show mesh"}
        </Button>
        <Button type="button" variant="soft" onClick={() => setShowPoints((v) => !v)}>
          {showPoints ? "Hide points" : "Show points"}
        </Button>
        <Button
          disabled={points.length === 0}
          type="button"
          variant="soft"
          onClick={() => setPoints((current) => current.slice(0, -1))}
        >
          Clear last
        </Button>
        <Button
          color="red"
          disabled={points.length === 0}
          type="button"
          variant="soft"
          onClick={() => setPoints([])}
        >
          Clear all
        </Button>
      </Flex>

      <Flex align="center" gap="3" justify="between" wrap="wrap">
        <Text size="2" weight="medium">
          {points.length}/{SYMBOL_POINT_COUNT} points placed
        </Text>
        <Button
          disabled={points.length !== SYMBOL_POINT_COUNT || saving}
          type="button"
          onClick={() => void handleSave()}
        >
          {saving ? "Saving…" : "Save symbols"}
        </Button>
      </Flex>
    </Flex>
  );
}

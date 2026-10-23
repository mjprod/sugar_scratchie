import { Callout, Card, Flex } from "@radix-ui/themes";
import { RunMode } from "./runMode";
import { VideoFlowShell } from "./VideoFlowShell";
import { useVideoFlowState } from "./useVideoFlowState";

export function VideoFlowRunPage() {
  const state = useVideoFlowState();
  const {
    flow,
    jobs,
    canUseGrok,
    canUseSourceAi,
    canUseWavespeed,
    health,
    enhancePrompt,
    setEnhancePrompt,
    image,
    setImage,
    theme,
    updateTheme,
    applyThemeToPrompts,
    picturePrompts,
    setPicturePrompts,
    pictureVariationCount,
    setPictureVariationCount,
    pictureCompareMode,
    setPictureCompareMode,
    pictureModels,
    setPictureModels,
    backgroundMotionPrompt,
    setBackgroundMotionPrompt,
    dressPrompt,
    setDressPrompt,
    dressReferenceImage,
    setDressReferenceImage,
    cardId,
    setCardId,
    cardLabel,
    setCardLabel,
    modelId,
    writeWebm,
    setWriteWebm,
    compressPreset,
    setCompressPreset,
    resolution,
    setResolution,
    tracker,
    setTracker,
    meshTune,
    setMeshTune,
    faceImage,
    setFaceImage,
    bikiniImage,
    setBikiniImage,
    aiProvider,
    sourceImageModel,
    backgroundVideoModel,
    setBackgroundVideoModel,
    dressVideoModel,
    setDressVideoModel,
    overlapPrompt,
    setOverlapPrompt,
    overlapPromptEnabled,
    setOverlapPromptEnabled,
    promptsDirty,
    draftSaving,
    saveDraft,
    error,
    setError,
    refreshHealth,
    refreshJobs,
    refreshProjects,
    activeProjectId,
  } = state;

  return (
    <VideoFlowShell
      active="run"
      error={error}
      subtitle={
        activeProjectId
          ? `Running “${flow.label}” for ${activeProjectId}. Switch cards from Models → Edit.`
          : `No card open — create or edit one from Models.`
      }
      title="Run flow"
      onRefresh={() => {
        refreshHealth().catch((caught) => setError(String(caught)));
        refreshJobs().catch(() => undefined);
        refreshProjects().catch(() => undefined);
      }}
    >
      {health && !health.xai_key_loaded && !health.wavespeed_key_loaded ? (
        <Callout.Root color="orange" mb="4">
          <Callout.Text>
            Add XAI_API_KEY and/or WAVESPEED_API_KEY to .env for video pipeline steps.
          </Callout.Text>
        </Callout.Root>
      ) : null}
      {!activeProjectId ? (
        <Callout.Root color="blue" mb="4">
          <Callout.Text>
            Open a motion card from <a href="/dashboard/models">Models</a> (Edit) to run the
            pipeline. New cards are created there too.
          </Callout.Text>
        </Callout.Root>
      ) : null}
      <Flex direction="column" gap="4">
        <Card size="4">
          <RunMode
            flow={flow}
            jobs={jobs}
            canUseGrok={canUseGrok}
            canUseSourceAi={canUseSourceAi}
            canUseWavespeed={canUseWavespeed}
            aiProvider={aiProvider}
            sourceImageModel={sourceImageModel}
            backgroundVideoModel={backgroundVideoModel}
            dressVideoModel={dressVideoModel}
            overlapPrompt={overlapPrompt}
            overlapPromptEnabled={overlapPromptEnabled}
            enhancePrompt={enhancePrompt}
            image={image}
            theme={theme}
            picturePrompts={picturePrompts}
            pictureVariationCount={pictureVariationCount}
            pictureCompareMode={pictureCompareMode}
            pictureModels={pictureModels}
            backgroundMotionPrompt={backgroundMotionPrompt}
            dressPrompt={dressPrompt}
            dressReferenceImage={dressReferenceImage}
            cardId={cardId}
            cardLabel={cardLabel}
            modelId={modelId}
            writeWebm={writeWebm}
            compressPreset={compressPreset}
            resolution={resolution}
            tracker={tracker}
            meshTune={meshTune}
            faceImage={faceImage}
            bikiniImage={bikiniImage}
            onImageChange={setImage}
            onThemeChange={updateTheme}
            onApplyThemeToPrompts={applyThemeToPrompts}
            onPicturePromptsChange={setPicturePrompts}
            onPictureVariationCountChange={setPictureVariationCount}
            onPictureCompareModeChange={setPictureCompareMode}
            onPictureModelsChange={setPictureModels}
            onBackgroundMotionPromptChange={setBackgroundMotionPrompt}
            onDressPromptChange={setDressPrompt}
            onDressReferenceImageChange={setDressReferenceImage}
            onCardIdChange={setCardId}
            onCardLabelChange={setCardLabel}
            onWriteWebmChange={setWriteWebm}
            onCompressPresetChange={setCompressPreset}
            onTrackerChange={setTracker}
            onMeshTuneChange={setMeshTune}
            onResolutionChange={setResolution}
            onFaceImageChange={setFaceImage}
            onBikiniImageChange={setBikiniImage}
            onBackgroundVideoModelChange={setBackgroundVideoModel}
            onDressVideoModelChange={setDressVideoModel}
            onOverlapPromptChange={setOverlapPrompt}
            onOverlapPromptEnabledChange={setOverlapPromptEnabled}
            onEnhancePromptChange={setEnhancePrompt}
            promptsDirty={promptsDirty}
            draftSaving={draftSaving}
            onSaveDraft={saveDraft}
            onRefreshJobs={refreshJobs}
            onRefreshAssets={async () => undefined}
            onError={setError}
          />
        </Card>
      </Flex>
    </VideoFlowShell>
  );
}

#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CANONICAL_STATE_DIR = ".qwen-harness";
export const AUTONOMOUS_STATE_DIR = ".qwen-autonomous";
export const DEFAULT_IMPLEMENTATION_MODEL = "llama-local/qwen36-27b-mtp-iq4xs";
export const DEFAULT_REVIEW_MODEL = "llama-local/qwen36-35b-a3b-iq4xs";
export const DEFAULT_SCOUT_MODEL = DEFAULT_REVIEW_MODEL;
export const DEFAULT_LOCAL_MODEL = DEFAULT_IMPLEMENTATION_MODEL;
export const DEFAULT_MODEL_ROUTES = {
  implementation: DEFAULT_IMPLEMENTATION_MODEL,
  correction: DEFAULT_IMPLEMENTATION_MODEL,
  scout: DEFAULT_SCOUT_MODEL,
  review: DEFAULT_REVIEW_MODEL
};
const DEFAULT_PI_MAX_BUFFER = 256 * 1024 * 1024;
const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_AUTONOMOUS_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_AUTONOMOUS_VERIFY_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 15000;
const DEFAULT_CHILD_SHUTDOWN_GRACE_MS = 5000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 120000;
const DEFAULT_PROVIDER_STATUS_TIMEOUT_MS = 5000;

export const PHASES = [
  "intake",
  "scout_prepare",
  "scout_worker",
  "scout_review",
  "design_package",
  "design_review",
  "package_implementation",
  "package_verification",
  "correction_package",
  "correction_worker",
  "correction_verification",
  "final_gate",
  "completed",
  "blocked"
];

const MUTATION_TOOLS = new Set(["edit", "write", "apply_patch"]);

export function nativeHybridPaths({ cwd = process.cwd() } = {}) {
  const root = join(resolve(cwd), CANONICAL_STATE_DIR);
  return {
    root,
    state: join(root, "state.json"),
    policy: join(root, "policy.json"),
    ownership: join(root, "ownership.json"),
    progress: join(root, "progress.json"),
    progressMarkdown: join(root, "progress.md"),
    events: join(root, "events.jsonl"),
    task: join(root, "task.md"),
    requirements: join(root, "requirements.md"),
    design: join(root, "design.md"),
    designGrill: join(root, "design-grill.md"),
    decisions: join(root, "decisions.md"),
    implementationPlan: join(root, "implementation-plan.json"),
    planReview: join(root, "plan-review.md"),
    scoutDir: join(root, "scout"),
    scoutHandoff: join(root, "scout", "scout-handoff.md"),
    repoMap: join(root, "scout", "repo-map.md"),
    scoutEvidence: join(root, "scout", "scout-evidence.json"),
    implementationPackagesDir: join(root, "implementation-packages"),
    correctionPackagesDir: join(root, "correction-packages"),
    handoffsDir: join(root, "handoffs"),
    workerRunsDir: join(root, "worker-runs"),
    localReviewsDir: join(root, "local-reviews"),
    verificationDir: join(root, "verification"),
    verificationResults: join(root, "verification", "verification-results.json"),
    evaluationDir: join(root, "evaluation"),
    metrics: join(root, "evaluation", "metrics.jsonl"),
    proofDir: join(root, "proof"),
    claimEvidenceMatrix: join(root, "proof", "claim-evidence-matrix.md"),
    claimEvidenceMatrixJson: join(root, "proof", "claim-evidence-matrix.json"),
    finalGate: join(root, "proof", "final-gate.json"),
    finalReview: join(root, "proof", "final-review.md")
  };
}

export function initHybridRun(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const task = requiredString(options.task, "task");
  const now = options.now ?? new Date().toISOString();
  const taskId = options.taskId ?? slugify(options.title ?? task);
  const runId = options.runId ?? "run-001";
  const title = options.title ?? taskId;
  const verificationCommand = normalizeCommand(options.verificationCommand);
  const localWorkerModel = options.model ?? DEFAULT_LOCAL_MODEL;
  const modelRoutes = {
    implementation: options.implementationModel ?? localWorkerModel,
    correction: options.correctionModel ?? options.implementationModel ?? localWorkerModel,
    scout: options.scoutModel ?? DEFAULT_SCOUT_MODEL,
    review: options.reviewModel ?? DEFAULT_REVIEW_MODEL
  };
  const paths = nativeHybridPaths({ cwd });

  for (const dir of [
    paths.root,
    paths.scoutDir,
    paths.implementationPackagesDir,
    paths.correctionPackagesDir,
    paths.handoffsDir,
    paths.workerRunsDir,
    paths.localReviewsDir,
    paths.verificationDir,
    paths.evaluationDir,
    paths.proofDir
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const state = {
    version: 2,
    host: "codex",
    stateDir: CANONICAL_STATE_DIR,
    taskId,
    runId,
    phase: "scout_prepare",
    title,
    task,
    currentPackageId: null,
    currentCorrectionId: null,
    createdAt: now,
    updatedAt: now,
    models: {
      frontier: "codex-native",
      localWorker: localWorkerModel,
      localImplementation: modelRoutes.implementation,
      localCorrection: modelRoutes.correction,
      localScout: modelRoutes.scout,
      localReview: modelRoutes.review,
      routes: modelRoutes,
      transport: "pi"
    },
    artifacts: {
      task: ".qwen-harness/task.md",
      requirements: ".qwen-harness/requirements.md",
      design: ".qwen-harness/design.md",
      designGrill: ".qwen-harness/design-grill.md",
      planReview: ".qwen-harness/plan-review.md",
      implementationPlan: ".qwen-harness/implementation-plan.json",
      progress: ".qwen-harness/progress.json",
      proof: ".qwen-harness/proof/final-gate.json"
    },
    tokenUsage: emptyTokenUsage()
  };
  const policy = defaultPolicy({ localWorkerModel, modelRoutes, activePhase: state.phase });
  const ownership = {
    version: 1,
    runtimeOwner: "codex-native",
    workerTransport: "pi",
    canonicalStateDir: CANONICAL_STATE_DIR,
    activeWorker: null,
    packages: [],
    corrections: [],
    finalGateOwner: "codex-native",
    updatedAt: now
  };
  const progress = {
    version: 1,
    host: "codex",
    taskId,
    runId,
    phase: state.phase,
    title,
    currentPackageId: null,
    currentCorrectionId: null,
    blockers: [],
    nextAction: "Run scout through a local Qwen worker via Pi, then have Codex write design and implementation packages.",
    verificationCommand,
    updatedAt: now,
    tokenUsage: emptyTokenUsage()
  };
  const implementationPlan = {
    version: 1,
    taskId,
    runId,
    packages: [],
    corrections: [],
    verificationCommand,
    tokenUsage: emptyTokenUsage()
  };

  writeFileSync(paths.task, taskMarkdown({ title, task, taskId, runId, verificationCommand }), "utf8");
  writeFileSync(paths.requirements, requirementsMarkdown({ task, verificationCommand }), "utf8");
  writeFileSync(paths.scoutHandoff, scoutHandoffMarkdown({ task, taskId, runId, verificationCommand }), "utf8");
  writeFileSync(paths.progressMarkdown, progressMarkdown(progress), "utf8");
  writeJson(paths.state, state);
  writeJson(paths.policy, policy);
  writeJson(paths.ownership, ownership);
  writeJson(paths.progress, progress);
  writeJson(paths.implementationPlan, implementationPlan);
  appendEvent(paths.events, { type: "hybrid_run_initialized", at: now, taskId, runId, phase: state.phase });

  return {
    ok: true,
    stateDir: CANONICAL_STATE_DIR,
    taskId,
    runId,
    phase: state.phase,
    nextAction: progress.nextAction
  };
}

export function loadHybridStatus(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const paths = nativeHybridPaths({ cwd });
  if (!existsSync(paths.state)) {
    return { active: false, stateDir: CANONICAL_STATE_DIR };
  }
  const state = readJson(paths.state) ?? {};
  const policy = readJson(paths.policy) ?? {};
  const progress = readJson(paths.progress) ?? {};
  const ownership = readJson(paths.ownership) ?? {};
  const finalGate = readJson(paths.finalGate);
  return {
    active: true,
    stateDir: CANONICAL_STATE_DIR,
    taskId: state.taskId ?? null,
    runId: state.runId ?? null,
    title: state.title ?? null,
    phase: progress.phase ?? state.phase ?? policy.activePhase ?? "unknown",
    currentPackageId: progress.currentPackageId ?? state.currentPackageId ?? null,
    currentCorrectionId: progress.currentCorrectionId ?? state.currentCorrectionId ?? null,
    runtimeOwner: policy.runtimeOwner ?? "codex-native",
    workerTransport: policy.workerTransport ?? "pi",
    activeWorker: ownership.activeWorker ?? null,
    nextAction: progress.nextAction ?? null,
    goalAchieved: Boolean(finalGate?.goalAchieved),
    updatedAt: progress.updatedAt ?? state.updatedAt ?? null
  };
}

export function createImplementationPackage(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const paths = nativeHybridPaths({ cwd });
  ensureActiveHarness(paths);
  mkdirSync(paths.implementationPackagesDir, { recursive: true });
  const packageId = options.packageId ?? options.package ?? nextNumberedId(paths.implementationPackagesDir, "P");
  const requestedVerificationCommand = normalizeCommand(options.verificationCommand);
  const verificationCommand = requestedVerificationCommand.length ? requestedVerificationCommand : defaultVerificationCommand(paths);
  const filePath = join(paths.implementationPackagesDir, `${packageId}.md`);
  const markdown = implementationPackageMarkdown({
    packageId,
    title: options.title ?? packageId,
    goal: requiredString(options.goal ?? options.instructions ?? options.task, "goal"),
    verificationCommand
  });
  writeFileSync(filePath, markdown, "utf8");
  updatePackageList({ cwd, packageId, status: "pending" });
  appendEvent(paths.events, { type: "implementation_package_created", at: new Date().toISOString(), packageId, path: stateRelative(filePath) });
  return { ok: true, packageId, path: filePath };
}

export function createCorrectionPackage(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const paths = nativeHybridPaths({ cwd });
  ensureActiveHarness(paths);
  mkdirSync(paths.correctionPackagesDir, { recursive: true });
  const targetPackageId = requiredString(options.packageId ?? options.package ?? options.targetPackageId, "package");
  const correctionId = options.correctionId ?? nextNumberedId(paths.correctionPackagesDir, "C");
  const reviewPath = options.review ? resolve(cwd, options.review) : join(paths.verificationDir, `${targetPackageId}-review.md`);
  const reviewText = existsSync(reviewPath) ? readFileSync(reviewPath, "utf8") : "No review file was available.";
  const filePath = join(paths.correctionPackagesDir, `${correctionId}-for-${targetPackageId}.md`);
  writeFileSync(filePath, correctionPackageMarkdown({ correctionId, targetPackageId, reviewPath, reviewText }), "utf8");
  updateCorrectionList({ cwd, correctionId, targetPackageId, status: "pending" });
  appendEvent(paths.events, { type: "correction_package_created", at: new Date().toISOString(), correctionId, targetPackageId, path: stateRelative(filePath) });
  return { ok: true, correctionId, targetPackageId, path: filePath };
}

export async function spawnWorker(options = {}) {
  const startedAtMs = Date.now();
  const cwd = resolve(options.cwd ?? process.cwd());
  const paths = nativeHybridPaths({ cwd });
  ensureActiveHarness(paths);
  const status = loadHybridStatus({ cwd });
  if (status.activeWorker) {
    throw new Error(`worker already active: ${status.activeWorker.workerRunId}`);
  }

  const packageId = options.packageId ?? options.package ?? null;
  const correctionId = options.correctionId ?? options.correction ?? null;
  const kind = options.kind ?? (correctionId ? "correction" : packageId ? "package" : "scout");
  const attempt = String(options.attempt ?? "001").padStart(3, "0");
  const workerRunId = workerRunIdFor({ kind, packageId, correctionId, attempt });
  const runDir = join(paths.workerRunsDir, workerRunId);
  mkdirSync(runDir, { recursive: true });

  const packagePath = resolveWorkerPackagePath({ paths, kind, packageId, correctionId });
  const packageMarkdown = existsSync(packagePath) ? readFileSync(packagePath, "utf8") : "";
  const requestedWorkerVerificationCommand = normalizeCommand(options.verificationCommand);
  const verificationCommand = requestedWorkerVerificationCommand.length ? requestedWorkerVerificationCommand : defaultVerificationCommand(paths);
  const evidencePath = join(runDir, "evidence.json");
  const prompt = workerPrompt({
    packageId: packageId ?? "scout",
    correctionId,
    attempt,
    packagePath,
    evidencePath,
    verificationCommand,
    packageMarkdown
  });
  const piBinary = options.piBinary ?? "pi";
  const model = options.model ?? defaultModelForWorker({ cwd, kind });
  const role = workerRoleForKind(kind);
  const piCommand = {
    command: piBinary,
    args: ["--mode", "json", "-p", "--no-session", "--model", model, prompt],
    cwd,
    mode: options.live ? "live" : "dry-run",
    role
  };
  const providerUrl = providerUrlFromOptions(options);
  const shouldProbeProvider = parseMaybeBoolean(options.providerProbe ?? options.probe ?? process.env.QWEN_HARNESS_PROVIDER_PROBE) === true;

  writeFileSync(join(runDir, "worker-prompt.md"), prompt, "utf8");
  writeJson(join(runDir, "pi-command.json"), piCommand);
  writeJson(join(runDir, "changed-files.json"), []);
  writeFileSync(join(runDir, "test-output.log"), "", "utf8");
  const beforeSnapshot = snapshotWorkspace(cwd);
  writeJson(join(runDir, "pre-snapshot.json"), Object.fromEntries(beforeSnapshot));

  const providerPreflight = providerUrl ? checkLlamaSwapProvider({
    providerUrl,
    model,
    probe: shouldProbeProvider,
    allowModelSwitch: parseMaybeBoolean(options.allowModelSwitch ?? process.env.QWEN_HARNESS_ALLOW_MODEL_SWITCH),
    providerTimeoutMs: options.providerTimeoutMs,
    curlBinary: options.curlBinary
  }) : null;
  if (providerPreflight) {
    writeJson(join(runDir, "provider-preflight.json"), providerPreflight);
  }
  if (providerPreflight && !providerPreflight.ok) {
    const evidence = {
      version: 1,
      workerRunId,
      packageId: packageId ?? null,
      correctionId: correctionId ?? null,
      phase: kind === "correction" ? "correction_worker" : kind === "scout" ? "scout_worker" : "package_implementation",
      transport: "pi",
      model,
      status: "failed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      filesRead: packagePath ? [stateRelative(packagePath)] : [],
      filesChanged: [],
      commandsRun: [],
      acceptanceEvidence: [],
      providerPreflight,
      blockers: providerPreflight.blockers ?? ["Model provider preflight failed."],
      residualRisks: ["Worker was not launched because the configured local model provider was not ready."],
      tokenUsage: emptyTokenUsage()
    };
    writeJson(evidencePath, evidence);
    writeFileSync(join(runDir, "worker-summary.md"), workerSummary(evidence), "utf8");
    appendMetric(paths.metrics, runMetric({
      workerRunId,
      kind,
      role,
      model,
      status: "failed",
      startedAtMs,
      tokenUsage: evidence.tokenUsage,
      filesChanged: [],
      exitCode: null,
      providerPreflight
    }));
    appendEvent(paths.events, { type: "worker_provider_preflight_failed", at: new Date().toISOString(), workerRunId, providerPreflight });
    return { ok: false, status: "failed", workerRunId, runDir, evidencePath, providerPreflight };
  }
  markActiveWorker({ cwd, workerRunId, packageId, correctionId, kind, runDir, model });

  let exitCode = null;
  let workerStatus = "prepared";
  let stdout = "";
  let stderr = "";
  let workerProcess = null;
  const stdoutRawPath = join(runDir, "stdout.jsonl");
  const stderrRawPath = join(runDir, "stderr.raw.log");
  const stdoutLogPath = join(runDir, "stdout.log");
  const stderrLogPath = join(runDir, "stderr.log");
  if (options.live) {
    const timeoutMs = Number(options.timeoutMs ?? 600000);
    workerProcess = await runPiProcessToFiles({
      command: piBinary,
      args: piCommand.args,
      cwd,
      stdoutPath: stdoutRawPath,
      stderrPath: stderrRawPath,
      timeoutMs,
      watchdogIntervalMs: positiveNumber(options.watchdogIntervalMs, DEFAULT_WATCHDOG_INTERVAL_MS),
      watchdog: async () => workerEvidenceReadyForWatchdog(evidencePath)
    });
    stdout = readCompactFile(stdoutRawPath, Number(options.maxLogBytes ?? DEFAULT_LOG_MAX_BYTES));
    stderr = readCompactFile(stderrRawPath, Number(options.maxLogBytes ?? DEFAULT_LOG_MAX_BYTES));
    exitCode = workerProcess.exitCode ?? (workerProcess.errorMessage ? 1 : 0);
    workerStatus = exitCode === 0 || workerProcess.watchdogTerminated ? "completed" : "failed";
    writeFileSync(stdoutLogPath, stdout, "utf8");
    writeFileSync(stderrLogPath, compactLog(stderr || workerProcess.errorMessage || "", Number(options.maxLogBytes ?? DEFAULT_LOG_MAX_BYTES)), "utf8");
  } else {
    workerStatus = "dry-run";
  }

  const toolExecutions = extractToolExecutions(stdout);
  const verificationOutputPath = join(runDir, "test-output.log");
  if (toolExecutions.length > 0 && !readFileSync(verificationOutputPath, "utf8").trim()) {
    writeFileSync(verificationOutputPath, toolExecutions.map((execution) => execution.output).filter(Boolean).join("\n\n---\n\n"), "utf8");
  }
  const changedFiles = diffSnapshots(beforeSnapshot, snapshotWorkspace(cwd));
  const parsedFileUsage = parsePiUsageFile(stdoutRawPath);
  const parsedUsage = tokenBucketHasValue(parsedFileUsage.local)
    ? parsedFileUsage
    : parsePiUsage(stdout);
  const synthesizedAcceptance = synthesizeAcceptanceEvidence({ changedFiles, toolExecutions, verificationCommand, runDir });
  const existingEvidence = normalizeWorkerEvidence(readJson(evidencePath));
  const evidenceDraft = existingEvidence && typeof existingEvidence === "object" ? {
    ...existingEvidence,
    workerRunId: existingEvidence.workerRunId ?? workerRunId,
    packageId: existingEvidence.packageId ?? packageId ?? null,
    correctionId: existingEvidence.correctionId ?? correctionId ?? null,
    phase: existingEvidence.phase ?? (kind === "correction" ? "correction_worker" : kind === "scout" ? "scout_worker" : "package_implementation"),
    transport: existingEvidence.transport ?? "pi",
    model,
    status: normalizeWorkerEvidenceStatus(existingEvidence.status, synthesizedAcceptance.length > 0 && changedFiles.length > 0 ? "completed" : workerStatus),
    filesChanged: mergeUnique(existingEvidence.filesChanged, changedFiles),
    commandsRun: normalizeCommandsRun(existingEvidence.commandsRun, { piBinary, piCommand, exitCode, runDir, options, toolExecutions }),
    acceptanceEvidence: normalizeAcceptanceEvidence(existingEvidence.acceptanceEvidence).length
      ? normalizeAcceptanceEvidence(existingEvidence.acceptanceEvidence)
      : synthesizedAcceptance,
    providerPreflight: existingEvidence.providerPreflight ?? providerPreflight ?? undefined,
    tokenUsage: preferMeasuredTokenUsage(existingEvidence.tokenUsage, parsedUsage),
    completedAt: existingEvidence.completedAt ?? new Date().toISOString()
  } : {
    version: 1,
    workerRunId,
    packageId: packageId ?? null,
    correctionId: correctionId ?? null,
    phase: kind === "correction" ? "correction_worker" : kind === "scout" ? "scout_worker" : "package_implementation",
    transport: "pi",
    model,
    status: synthesizedAcceptance.length > 0 && changedFiles.length > 0 ? "completed" : workerStatus,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    filesRead: packagePath ? [stateRelative(packagePath)] : [],
    filesChanged: changedFiles,
    commandsRun: toolExecutions.length > 0 ? toolExecutions.map((execution) => ({
      command: execution.command,
      exitCode: execution.exitCode,
      outputPath: stateRelative(verificationOutputPath),
      summary: execution.exitCode === 0 ? "Tool command passed." : "Tool command completed."
    })) : [
      {
        command: [piBinary, ...piCommand.args.slice(0, 6), "<worker prompt>"].join(" "),
        exitCode,
        outputPath: stateRelative(join(runDir, "stdout.log")),
        summary: options.live ? "Pi worker invocation finished." : "Dry-run prepared Pi worker artifacts."
      }
    ],
    acceptanceEvidence: synthesizedAcceptance,
    synthesizedByHarness: synthesizedAcceptance.length > 0 && workerStatus === "failed",
    providerPreflight: providerPreflight ?? undefined,
    blockers: workerStatus === "failed" && synthesizedAcceptance.length === 0 ? [stderr || "Pi worker failed."] : [],
    residualRisks: [],
    tokenUsage: parsedUsage
  };
  const evidence = normalizeWorkerEvidence(evidenceDraft, {
    workerRunId,
    packageId: packageId ?? null,
    correctionId: correctionId ?? null,
    fallbackStatus: synthesizedAcceptance.length > 0 && changedFiles.length > 0 ? "completed" : workerStatus,
    filesChanged: changedFiles,
    parsedUsage
  });
  writeJson(evidencePath, evidence);
  writeFileSync(join(runDir, "worker-summary.md"), workerSummary(evidence), "utf8");
  writeJson(join(runDir, "changed-files.json"), changedFiles);
  updateAggregateTokenUsage({ cwd, usage: evidence.tokenUsage });
  appendMetric(paths.metrics, runMetric({
    workerRunId,
    kind,
    role,
    model,
    status: evidence.status ?? workerStatus,
    startedAtMs,
    tokenUsage: evidence.tokenUsage,
    filesChanged: changedFiles,
    exitCode,
    providerPreflight,
    watchdogTerminated: workerProcess?.watchdogTerminated ?? false
  }));
  clearActiveWorker({ cwd, workerRunId, status: evidence.status ?? workerStatus });
  appendEvent(paths.events, { type: "worker_run_recorded", at: new Date().toISOString(), workerRunId, status: workerStatus });

  return { ok: evidence.status !== "failed", status: evidence.status, workerRunId, runDir, evidencePath };
}

export async function runAutonomous(options = {}) {
  const projectDir = resolve(options.project ?? options.cwd ?? process.cwd());
  const wantsDetached = parseMaybeBoolean(options.detached ?? options.background ?? options.async) === true
    && parseMaybeBoolean(options.validateOnly) !== true
    && parseMaybeBoolean(options.dryRun) !== true;
  if (wantsDetached) {
    return runAutonomousDetached({ ...options, project: projectDir });
  }
  const verificationCommand = normalizeCommand(options.verificationCommand);
  const command = verificationCommand.length ? verificationCommand : ["npm", "test"];
  const commandText = command.join(" ");
  const minTests = nonNegativeInteger(options.minTests, 1);
  const repairAttempts = nonNegativeInteger(options.repairAttempts, 1);
  const maxInternalLoops = nonNegativeInteger(options.maxInternalLoops, 4);
  const evidenceFile = options.evidenceFile ?? "evidence.json";
  const stateDir = join(projectDir, AUTONOMOUS_STATE_DIR);
  const runsDir = join(stateDir, "runs");
  const latestPath = join(stateDir, "latest.json");
  const requiredFiles = autonomousRequiredFiles({ command, requiredFiles: options.requiredFiles });

  if (parseMaybeBoolean(options.validateOnly) === true) {
    const validation = validateAutonomousProject({
      projectDir,
      command,
      evidenceFile,
      minTests,
      requiredFiles,
      verifyTimeoutMs: options.verifyTimeoutMs
    });
    const result = { mode: "autonomous-validate", status: validation.status, projectDir, validation };
    writeJson(latestPath, result);
    updateAutonomousJobFromEnv(result);
    return result;
  }

  const taskText = readAutonomousTaskText(options);
  ensureAutonomousProjectDir(projectDir, parseMaybeBoolean(options.allowExisting) === true);
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(stateDir, "task.original.md"), taskText, "utf8");

  const prompt = autonomousPrompt({
    taskText,
    projectDir,
    commandText,
    minTests,
    evidenceFile,
    maxInternalLoops
  });
  writeFileSync(join(stateDir, "task.md"), prompt, "utf8");

  const attempts = [];
  const initialRunDir = join(runsDir, `${timestampId()}-initial`);
  if (parseMaybeBoolean(options.dryRun) === true) {
    mkdirSync(initialRunDir, { recursive: true });
    const promptPath = join(initialRunDir, "prompt.md");
    writeFileSync(promptPath, prompt, "utf8");
    const result = {
      mode: "autonomous-dry-run",
      status: "prepared",
      projectDir,
      promptPath,
      requiredFiles,
      verificationCommand: commandText
    };
    writeJson(latestPath, result);
    updateAutonomousJobFromEnv(result);
    return result;
  }

  attempts.push(await runAutonomousPiAttempt({ options, projectDir, runDir: initialRunDir, prompt, command, evidenceFile, minTests, requiredFiles }));

  let validation = validateAutonomousProject({
    projectDir,
    command,
    evidenceFile,
    minTests,
    requiredFiles,
    verifyTimeoutMs: options.verifyTimeoutMs
  });

  for (let index = 0; validation.status !== "passed" && index < repairAttempts; index += 1) {
    const repairRunDir = join(runsDir, `${timestampId()}-repair-${index + 1}`);
    const repairPrompt = autonomousRepairPrompt({
      validation,
      commandText,
      minTests,
      evidenceFile,
      maxInternalLoops
    });
    attempts.push(await runAutonomousPiAttempt({ options, projectDir, runDir: repairRunDir, prompt: repairPrompt, command, evidenceFile, minTests, requiredFiles }));
    validation = validateAutonomousProject({
      projectDir,
      command,
      evidenceFile,
      minTests,
      requiredFiles,
      verifyTimeoutMs: options.verifyTimeoutMs
    });
  }

  const result = {
    mode: "autonomous-run",
    status: validation.status,
    projectDir,
    model: options.model ?? DEFAULT_IMPLEMENTATION_MODEL,
    verificationCommand: commandText,
    requiredFiles,
    attempts,
    validation,
    tokenUsage: attempts.reduce((total, attempt) => mergeTokenUsage(total, attempt.tokenUsage), emptyTokenUsage())
  };
  writeJson(latestPath, result);
  updateAutonomousJobFromEnv(result);
  return result;
}

export function autonomousJobStatus(options = {}) {
  const projectDir = resolve(options.project ?? options.cwd ?? process.cwd());
  const stateDir = join(projectDir, AUTONOMOUS_STATE_DIR);
  const jobsDir = join(stateDir, "jobs");
  const jobId = options.jobId ?? latestJobId(jobsDir);
  if (!jobId) {
    return { mode: "autonomous-job-status", status: "missing", projectDir, jobId: null, reason: "no autonomous jobs found" };
  }
  const jobPath = join(jobsDir, jobId, "job.json");
  const job = readJson(jobPath) ?? {};
  const latest = readJson(join(stateDir, "latest.json"));
  const running = job.completedAt ? false : processIsRunning(job.pid);
  const status = latest?.status && !running
    ? latest.status
    : running
      ? "running"
      : job.status === "running"
        ? "exited"
        : job.status ?? "unknown";
  return {
    mode: "autonomous-job-status",
    status,
    projectDir,
    jobId,
    pid: job.pid ?? null,
    running,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    stdoutPath: job.stdoutPath ?? null,
    stderrPath: job.stderrPath ?? null,
    latestPath: existsSync(join(stateDir, "latest.json")) ? join(stateDir, "latest.json") : null,
    latest
  };
}

function runAutonomousDetached(options = {}) {
  const projectDir = resolve(options.project ?? options.cwd ?? process.cwd());
  const stateDir = join(projectDir, AUTONOMOUS_STATE_DIR);
  const jobsDir = join(stateDir, "jobs");
  const jobId = options.jobId ?? timestampId();
  const jobDir = join(jobsDir, jobId);
  mkdirSync(jobDir, { recursive: true });
  const jobTaskPath = join(jobDir, "task.md");
  const stdoutPath = join(jobDir, "job.stdout.log");
  const stderrPath = join(jobDir, "job.stderr.log");
  writeFileSync(jobTaskPath, readAutonomousTaskText(options), "utf8");
  const jobPath = join(jobDir, "job.json");
  const args = [
    fileURLToPath(import.meta.url),
    "autonomous-run",
    "--project",
    projectDir,
    "--task-file",
    jobTaskPath,
    "--min-tests",
    String(nonNegativeInteger(options.minTests, 1)),
    "--repair-attempts",
    String(nonNegativeInteger(options.repairAttempts, 1)),
    "--max-internal-loops",
    String(nonNegativeInteger(options.maxInternalLoops, 4)),
    "--evidence-file",
    options.evidenceFile ?? "evidence.json",
    "--timeout-ms",
    String(positiveNumber(options.timeoutMs, DEFAULT_AUTONOMOUS_TIMEOUT_MS)),
    "--verify-timeout-ms",
    String(positiveNumber(options.verifyTimeoutMs, DEFAULT_AUTONOMOUS_VERIFY_TIMEOUT_MS))
  ];
  const model = options.model ?? DEFAULT_IMPLEMENTATION_MODEL;
  if (model) args.push("--model", model);
  if (options.piBinary) args.push("--pi-binary", options.piBinary);
  if (options.watchdogIntervalMs) args.push("--watchdog-interval-ms", String(options.watchdogIntervalMs));
  if (parseMaybeBoolean(options.allowExisting) === true) args.push("--allow-existing");
  for (const file of Array.isArray(options.requiredFiles) ? options.requiredFiles : []) args.push("--require-file", String(file));
  const verificationCommand = normalizeCommand(options.verificationCommand);
  if (verificationCommand.length) args.push("--verification-command", ...verificationCommand);
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  const child = spawn(process.execPath, args, {
    cwd: projectDir,
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    env: {
      ...process.env,
      QWEN_HARNESS_JOB_PATH: jobPath
    }
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  child.unref();
  const job = {
    version: 1,
    mode: "autonomous-run-detached",
    status: "running",
    jobId,
    pid: child.pid,
    projectDir,
    startedAt: new Date().toISOString(),
    stdoutPath,
    stderrPath,
    command: [process.execPath, ...args],
    model,
    verificationCommand: verificationCommand.length ? verificationCommand.join(" ") : "npm test"
  };
  writeJson(jobPath, job);
  return {
    mode: "autonomous-run-detached",
    status: "running",
    projectDir,
    jobId,
    pid: child.pid,
    jobPath,
    stdoutPath,
    stderrPath,
    statusCommand: `qwen-harness-codex autonomous-status --project ${JSON.stringify(projectDir)} --job-id ${JSON.stringify(jobId)}`
  };
}

function latestJobId(jobsDir) {
  if (!existsSync(jobsDir)) return null;
  return safeReadDir(jobsDir)
    .filter((name) => existsSync(join(jobsDir, name, "job.json")))
    .sort()
    .at(-1) ?? null;
}

function processIsRunning(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function updateAutonomousJobFromEnv(result) {
  const jobPath = process.env.QWEN_HARNESS_JOB_PATH;
  if (!jobPath) return;
  const existing = readJson(jobPath) ?? {};
  writeJson(jobPath, {
    ...existing,
    status: result?.status ?? "unknown",
    completedAt: new Date().toISOString(),
    result
  });
}

export function validateAutonomousProject(options = {}) {
  const projectDir = resolve(options.projectDir ?? options.project ?? options.cwd ?? process.cwd());
  const command = normalizeCommand(options.command ?? options.verificationCommand);
  const verificationCommand = command.length ? command : ["npm", "test"];
  const commandText = verificationCommand.join(" ");
  const evidenceFile = options.evidenceFile ?? "evidence.json";
  const minTests = nonNegativeInteger(options.minTests, 1);
  const requiredFiles = autonomousRequiredFiles({ command: verificationCommand, requiredFiles: options.requiredFiles });
  const verifyTimeoutMs = positiveNumber(options.verifyTimeoutMs, DEFAULT_AUTONOMOUS_VERIFY_TIMEOUT_MS);
  const failures = [];
  const warnings = [];
  const evidencePath = join(projectDir, evidenceFile);

  for (const file of requiredFiles) {
    if (!existsSync(join(projectDir, file))) failures.push(`required file missing: ${file}`);
  }

  const evidence = normalizeAutonomousEvidence(readJson(evidencePath), { commandText });
  if (!evidence) {
    failures.push(`evidence file missing or invalid: ${evidenceFile}`);
  } else {
    if (evidence.status !== "passed") failures.push(`evidence.status is not passed: ${JSON.stringify(evidence.status)}`);
    if (evidence.testCommand !== commandText) failures.push(`evidence.testCommand mismatch: ${JSON.stringify(evidence.testCommand)} !== ${JSON.stringify(commandText)}`);
    const tests = evidence.tests ?? {};
    if (!Number.isFinite(Number(tests.total)) || Number(tests.total) < minTests) failures.push(`evidence tests.total is below ${minTests}: ${JSON.stringify(tests.total)}`);
    if (Number.isFinite(Number(tests.fail)) && Number(tests.fail) !== 0) failures.push(`evidence tests.fail is not 0: ${tests.fail}`);
    failures.push(...validateAutonomousChangedFiles(evidence, projectDir));
  }

  let verification = null;
  if (failures.length === 0 && parseMaybeBoolean(options.runVerification) !== false) {
    const validationDir = join(projectDir, AUTONOMOUS_STATE_DIR, "validation");
    mkdirSync(validationDir, { recursive: true });
    const stdoutPath = join(validationDir, "verification.stdout.log");
    const stderrPath = join(validationDir, "verification.stderr.log");
    const result = runVerificationCommand({
      command: verificationCommand,
      cwd: projectDir,
      timeoutMs: verifyTimeoutMs,
      stdoutPath,
      stderrPath
    });
    const parsedTests = parseAutonomousTestCounts(`${result.stdout}\n${result.stderr}`);
    verification = {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stdoutPath,
      stderrPath,
      parsedTests
    };
    if (result.timedOut) failures.push(`verification command timed out after ${verifyTimeoutMs}ms`);
    if (result.exitCode !== 0) failures.push(`verification command exited ${result.exitCode}`);
    if (parsedTests.total === 0) failures.push("verification command reported zero tests");
    else if (Number.isFinite(parsedTests.total) && parsedTests.total < minTests) failures.push(`verification command reported only ${parsedTests.total} tests`);
    else if (parsedTests.total === null) warnings.push("could not parse test count from verification output; using evidence tests count");
    if (Number.isFinite(parsedTests.fail) && parsedTests.fail !== 0) failures.push(`verification command reported ${parsedTests.fail} failed tests`);
  }

  return {
    status: failures.length === 0 ? "passed" : "failed",
    projectDir,
    evidencePath,
    failures,
    warnings,
    evidence,
    verification
  };
}

export function checkLlamaSwapProvider(options = {}) {
  const baseUrl = normalizeProviderUrl(providerUrlFromOptions(options));
  if (!baseUrl) {
    return {
      ok: false,
      provider: "llama-swap",
      blockers: ["Provider URL is required. Pass --provider-url or set QWEN_HARNESS_PROVIDER_URL."]
    };
  }
  const model = normalizeProviderModel(options.model ?? DEFAULT_LOCAL_MODEL);
  const providerTimeoutMs = positiveNumber(options.providerTimeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS);
  const statusTimeoutMs = Math.min(providerTimeoutMs, DEFAULT_PROVIDER_STATUS_TIMEOUT_MS);
  const allowModelSwitch = parseMaybeBoolean(options.allowModelSwitch);
  const modelSwitchAllowed = allowModelSwitch !== false;
  const probe = parseMaybeBoolean(options.probe ?? options.providerProbe) === true;
  const curlBinary = options.curlBinary ?? "curl";
  const checkedAt = new Date().toISOString();

  const health = curlHttp({ curlBinary, url: `${baseUrl}/health`, timeoutMs: statusTimeoutMs });
  const models = curlJson({ curlBinary, url: `${baseUrl}/v1/models`, timeoutMs: statusTimeoutMs });
  const running = curlJson({ curlBinary, url: `${baseUrl}/running`, timeoutMs: statusTimeoutMs });
  const listedModels = Array.isArray(models.body?.data) ? models.body.data.map((item) => item?.id).filter(Boolean) : [];
  const runningModels = Array.isArray(running.body?.running) ? running.body.running : [];
  const targetListed = listedModels.includes(model);
  const targetRunning = runningModels.some((item) => item?.model === model);
  const otherRunning = runningModels.filter((item) => item?.model && item.model !== model);
  const blockers = [];

  if (!health.ok || !/^OK\b/i.test(String(health.text ?? "").trim())) {
    blockers.push(`llama-swap /health failed: ${health.error ?? health.statusCode ?? "unknown"}`);
  }
  if (!models.ok) {
    blockers.push(`llama-swap /v1/models failed: ${models.error ?? models.statusCode ?? "unknown"}`);
  } else if (!targetListed) {
    blockers.push(`Target model ${model} is not listed by /v1/models.`);
  }
  if (!running.ok) {
    blockers.push(`llama-swap /running failed: ${running.error ?? running.statusCode ?? "unknown"}`);
  }
  if (otherRunning.length > 0 && !targetRunning && !modelSwitchAllowed) {
    blockers.push(`A different model is running: ${otherRunning.map((item) => `${item.model}:${item.state ?? "unknown"}`).join(", ")}.`);
  }

  let completionProbe = null;
  if (probe && blockers.length === 0) {
    completionProbe = curlJson({
      curlBinary,
      url: `${baseUrl}/v1/chat/completions`,
      method: "POST",
      timeoutMs: providerTimeoutMs,
      body: {
        model,
        messages: [{ role: "user", content: "Reply with OK only." }],
        max_tokens: 8,
        temperature: 0
      }
    });
    const content = completionProbe.body?.choices?.[0]?.message?.content ?? "";
    if (!completionProbe.ok) {
      blockers.push(`Tiny completion probe failed: ${completionProbe.error ?? completionProbe.statusCode ?? "unknown"}`);
    } else if (!/\bOK\b/i.test(String(content))) {
      blockers.push("Tiny completion probe did not return OK.");
    }
  }

  const ok = blockers.length === 0;
  return {
    ok,
    provider: "llama-swap",
    checkedAt,
    baseUrl,
    requestedModel: options.model ?? DEFAULT_LOCAL_MODEL,
    targetModel: model,
    targetListed,
    targetRunning,
    allowModelSwitch: modelSwitchAllowed,
    probe,
    health: summarizeHttpResult(health),
    models: {
      ok: models.ok,
      statusCode: models.statusCode,
      listed: listedModels
    },
    running: {
      ok: running.ok,
      statusCode: running.statusCode,
      models: runningModels.map((item) => ({
        model: item.model,
        state: item.state,
        ttl: item.ttl,
        proxy: item.proxy
      }))
    },
    completionProbe: completionProbe ? {
      ok: completionProbe.ok,
      statusCode: completionProbe.statusCode,
      durationMs: completionProbe.durationMs,
      usage: completionProbe.body?.usage ?? null,
      content: completionProbe.body?.choices?.[0]?.message?.content ?? null,
      error: completionProbe.error
    } : null,
    blockers
  };
}

export function verifyPackage(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const paths = nativeHybridPaths({ cwd });
  ensureActiveHarness(paths);
  const packageId = requiredString(options.packageId ?? options.package, "package");
  mkdirSync(paths.verificationDir, { recursive: true });
  const latestEvidence = normalizeWorkerEvidence(findLatestEvidence(paths.workerRunsDir, packageId));
  const claims = buildClaimsFromEvidence(latestEvidence);
  const evidenceStatus = normalizeWorkerEvidenceStatus(latestEvidence?.status, latestEvidence?.status);
  const passed = latestEvidence && evidenceStatus === "completed" && claims.every((claim) => claim.verdict === "pass");
  const verdict = passed ? "PASS" : "REQUEST_CHANGES";
  const result = {
    version: 1,
    packageId,
    attemptId: latestEvidence?.workerRunId ?? null,
    verdict,
    reviewedAt: new Date().toISOString(),
    claims,
    blockingIssues: passed ? [] : ["Worker evidence is missing, incomplete, failed, or not strong enough for approval."],
    requiredCorrections: passed ? [] : ["Create a correction package with concrete failed claims and rerun a local Qwen worker."],
    nextAction: passed ? "mark_package_complete" : "create_correction_package"
  };
  const reviewPath = join(paths.verificationDir, `${packageId}-review.md`);
  writeFileSync(reviewPath, verificationMarkdown(result), "utf8");
  appendVerificationResult(paths.verificationResults, result);
  updatePackageList({ cwd, packageId, status: passed ? "PASS" : "REQUEST_CHANGES" });
  appendEvent(paths.events, { type: "package_verified", at: result.reviewedAt, packageId, verdict });
  return { ok: true, verdict, reviewPath, result };
}

export function recoverActiveWorker(options = {}) {
  const startedAtMs = Date.now();
  const cwd = resolve(options.cwd ?? process.cwd());
  const paths = nativeHybridPaths({ cwd });
  ensureActiveHarness(paths);
  const ownership = readJson(paths.ownership) ?? {};
  const active = ownership.activeWorker;
  if (!active) return { ok: true, recovered: false, reason: "no active worker" };

  const startedAt = Date.parse(active.startedAt ?? "");
  const ageMs = Number.isFinite(startedAt) ? Date.now() - startedAt : Infinity;
  const maxAgeMs = Number(options.maxAgeMs ?? 15 * 60 * 1000);
  if (!options.force && Number.isFinite(ageMs) && ageMs < maxAgeMs) {
    return { ok: false, recovered: false, reason: `active worker is not stale yet: ${active.workerRunId}`, ageMs, maxAgeMs };
  }

  const runDir = resolve(cwd, active.runDir ?? join(CANONICAL_STATE_DIR, "worker-runs", active.workerRunId));
  const evidencePath = join(runDir, "evidence.json");
  mkdirSync(runDir, { recursive: true });
  const preSnapshot = objectToSnapshot(readJson(join(runDir, "pre-snapshot.json")));
  const changedFiles = preSnapshot ? diffSnapshots(preSnapshot, snapshotWorkspace(cwd)) : readJson(join(runDir, "changed-files.json")) ?? [];
  const inferredStatus = normalizeWorkerEvidenceStatus(options.status, inferRecoveredStatus(runDir));
  const existingEvidence = normalizeWorkerEvidence(readJson(evidencePath));
  const evidenceDraft = existingEvidence && typeof existingEvidence === "object" ? {
    ...existingEvidence,
    status: normalizeWorkerEvidenceStatus(options.status, existingEvidence.status ?? inferredStatus),
    filesChanged: mergeUnique(existingEvidence.filesChanged, changedFiles),
    completedAt: existingEvidence.completedAt ?? new Date().toISOString()
  } : {
    version: 1,
    workerRunId: active.workerRunId,
    packageId: active.packageId ?? null,
    correctionId: active.correctionId ?? null,
    phase: active.kind === "correction" ? "correction_worker" : active.kind === "scout" ? "scout_worker" : "package_implementation",
    transport: "pi",
    model: active.model ?? defaultModelForWorker({ cwd, kind: active.kind }),
    status: inferredStatus,
    startedAt: active.startedAt ?? null,
    completedAt: new Date().toISOString(),
    filesRead: [],
    filesChanged: Array.isArray(changedFiles) ? changedFiles : [],
    commandsRun: recoveredCommands(runDir),
    acceptanceEvidence: [],
    blockers: inferredStatus === "completed" ? [] : ["Worker was recovered after an interrupted or stale launcher process."],
    residualRisks: inferredStatus === "completed" ? ["Evidence was recovered after launcher interruption; rerun if stronger evidence is needed."] : [],
    tokenUsage: emptyTokenUsage()
  };
  const evidence = normalizeWorkerEvidence(evidenceDraft, {
    workerRunId: active.workerRunId,
    packageId: active.packageId ?? null,
    correctionId: active.correctionId ?? null,
    fallbackStatus: inferredStatus,
    filesChanged: Array.isArray(changedFiles) ? changedFiles : []
  });
  writeJson(evidencePath, evidence);
  writeJson(join(runDir, "changed-files.json"), Array.isArray(changedFiles) ? changedFiles : []);
  writeFileSync(join(runDir, "worker-summary.md"), workerSummary(evidence), "utf8");
  appendMetric(paths.metrics, runMetric({
    workerRunId: active.workerRunId,
    kind: active.kind ?? "package",
    role: workerRoleForKind(active.kind ?? "package"),
    model: evidence.model,
    status: `recovered:${evidence.status}`,
    startedAtMs,
    tokenUsage: evidence.tokenUsage,
    filesChanged: evidence.filesChanged,
    exitCode: null
  }));
  clearActiveWorker({ cwd, workerRunId: active.workerRunId, status: `recovered:${evidence.status}` });
  updatePhase({
    cwd,
    phase: active.kind === "scout" ? "scout_review" : active.kind === "correction" ? "correction_verification" : "package_verification",
    nextAction: `Recovered stale worker ${active.workerRunId}; verify its evidence before continuing.`
  });
  appendEvent(paths.events, { type: "worker_recovered", at: new Date().toISOString(), workerRunId: active.workerRunId, status: evidence.status });
  return { ok: true, recovered: true, workerRunId: active.workerRunId, status: evidence.status, evidencePath };
}

export function runLocalReview(options = {}) {
  const startedAtMs = Date.now();
  const cwd = resolve(options.cwd ?? process.cwd());
  const paths = nativeHybridPaths({ cwd });
  ensureActiveHarness(paths);
  const packageId = requiredString(options.packageId ?? options.package, "package");
  const model = options.model ?? defaultModelForRole({ cwd, role: "review" });
  const reviewId = options.reviewId ?? `${packageId}-local-review-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  const reviewDir = join(paths.localReviewsDir, reviewId);
  mkdirSync(reviewDir, { recursive: true });
  const packagePath = join(paths.implementationPackagesDir, `${packageId}.md`);
  const evidence = findLatestEvidence(paths.workerRunsDir, packageId);
  const prompt = localReviewPrompt({
    packageId,
    packagePath,
    evidencePath: evidence?.workerRunId ? join(paths.workerRunsDir, evidence.workerRunId, "evidence.json") : null
  });
  const piBinary = options.piBinary ?? "pi";
  const args = ["--mode", "json", "-p", "--no-session", "--tools", "read,bash,grep,find,ls", "--model", model, prompt];
  writeJson(join(reviewDir, "pi-command.json"), { command: piBinary, args, cwd, role: "review", mode: options.live ? "live" : "dry-run" });
  const providerUrl = providerUrlFromOptions(options);
  const providerPreflight = providerUrl ? checkLlamaSwapProvider({
    providerUrl,
    model,
    probe: parseMaybeBoolean(options.providerProbe ?? options.probe ?? process.env.QWEN_HARNESS_PROVIDER_PROBE) === true,
    allowModelSwitch: parseMaybeBoolean(options.allowModelSwitch ?? process.env.QWEN_HARNESS_ALLOW_MODEL_SWITCH),
    providerTimeoutMs: options.providerTimeoutMs,
    curlBinary: options.curlBinary
  }) : null;
  if (providerPreflight) writeJson(join(reviewDir, "provider-preflight.json"), providerPreflight);
  if (providerPreflight && !providerPreflight.ok) {
    const review = {
      version: 1,
      reviewId,
      packageId,
      role: "review",
      transport: "pi",
      model,
      status: "failed",
      verdict: "ERROR",
      outputPath: null,
      reviewText: "",
      providerPreflight,
      blockers: providerPreflight.blockers ?? ["Model provider preflight failed."],
      tokenUsage: emptyTokenUsage(),
      completedAt: new Date().toISOString()
    };
    writeJson(join(reviewDir, "review.json"), review);
    writeFileSync(join(reviewDir, "review.md"), localReviewMarkdown(review), "utf8");
    appendMetric(paths.metrics, runMetric({
      workerRunId: reviewId,
      kind: "review",
      role: "review",
      model,
      status: "failed",
      startedAtMs,
      tokenUsage: review.tokenUsage,
      filesChanged: [],
      exitCode: null,
      providerPreflight
    }));
    appendEvent(paths.events, { type: "local_review_provider_preflight_failed", at: review.completedAt, reviewId, packageId, providerPreflight });
    return { ok: false, status: "failed", reviewId, reviewPath: join(reviewDir, "review.json"), verdict: "ERROR", providerPreflight };
  }

  let exitCode = null;
  let stdout = "";
  let stderr = "";
  let status = "dry-run";
  if (options.live) {
    const result = spawnSync(piBinary, args, {
      cwd,
      encoding: "utf8",
      shell: false,
      timeout: Number(options.timeoutMs ?? 600000),
      maxBuffer: Number(options.maxBuffer ?? DEFAULT_PI_MAX_BUFFER)
    });
    stdout = result.stdout ?? "";
    stderr = result.stderr || result.error?.message || "";
    exitCode = result.status ?? (result.error ? 1 : 0);
    status = exitCode === 0 ? "completed" : "failed";
    writeFileSync(join(reviewDir, "stdout.log"), compactLog(stdout, Number(options.maxLogBytes ?? DEFAULT_LOG_MAX_BYTES)), "utf8");
    writeFileSync(join(reviewDir, "stderr.log"), compactLog(stderr, Number(options.maxLogBytes ?? DEFAULT_LOG_MAX_BYTES)), "utf8");
  }

  const tokenUsage = parsePiUsage(stdout);
  const reviewText = extractFinalAssistantText(stdout);
  const review = {
    version: 1,
    reviewId,
    packageId,
    role: "review",
    transport: "pi",
    model,
    status,
    verdict: status === "completed" ? inferReviewVerdict(reviewText) : "ERROR",
    outputPath: stateRelative(join(reviewDir, "stdout.log")),
    reviewText,
    providerPreflight: providerPreflight ?? undefined,
    blockers: status === "failed" ? [stderr || "Pi local review failed."] : [],
    tokenUsage,
    completedAt: new Date().toISOString()
  };
  writeJson(join(reviewDir, "review.json"), review);
  writeFileSync(join(reviewDir, "review.md"), localReviewMarkdown(review), "utf8");
  updateAggregateTokenUsage({ cwd, usage: tokenUsage });
  appendMetric(paths.metrics, runMetric({
    workerRunId: reviewId,
    kind: "review",
    role: "review",
    model,
    status: review.status,
    startedAtMs,
    tokenUsage,
    filesChanged: [],
    exitCode,
    providerPreflight
  }));
  appendEvent(paths.events, { type: "local_review_recorded", at: review.completedAt, reviewId, packageId, verdict: review.verdict });
  return { ok: status !== "failed", status, reviewId, reviewPath: join(reviewDir, "review.json"), verdict: review.verdict };
}

export function runFinalGate(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const paths = nativeHybridPaths({ cwd });
  ensureActiveHarness(paths);
  const status = loadHybridStatus({ cwd });
  const verificationResults = readJson(paths.verificationResults) ?? { reviews: [] };
  const reviews = Array.isArray(verificationResults.reviews) ? verificationResults.reviews : [];
  const blockingIssues = [];

  if (status.activeWorker) blockingIssues.push(`Active worker still running: ${status.activeWorker.workerRunId}`);
  if (!planReviewReady(paths.planReview)) blockingIssues.push("plan-review.md is missing or not READY.");
  if (reviews.length === 0) blockingIssues.push("No package verification reviews exist.");
  for (const review of reviews) {
    if (review.verdict !== "PASS") blockingIssues.push(`Package ${review.packageId} is not PASS.`);
    for (const claim of review.claims ?? []) {
      if (claim.evidenceType === "smoke" && /behavior|runtime|user|flow/i.test(String(claim.claim))) {
        blockingIssues.push(`Behavioral claim for ${review.packageId} only has smoke evidence.`);
      }
      if (claim.verdict !== "pass") blockingIssues.push(`Claim did not pass for ${review.packageId}: ${claim.claim}`);
    }
  }

  const requestedGoal = parseMaybeBoolean(options.goalAchieved);
  const goalAchieved = requestedGoal === false ? false : blockingIssues.length === 0;
  const verdict = goalAchieved ? "APPROVE" : "REQUEST_CHANGES";
  const matrix = claimEvidenceMatrixMarkdown(reviews);
  writeFileSync(paths.claimEvidenceMatrix, matrix, "utf8");
  writeJson(paths.claimEvidenceMatrixJson, { version: 1, reviews });
  const finalGate = {
    version: 1,
    goalAchieved,
    verdict,
    checkedAt: new Date().toISOString(),
    packages: reviews.map((review) => ({ packageId: review.packageId, verdict: review.verdict })),
    corrections: [],
    acceptanceCriteria: reviews.flatMap((review) => review.claims ?? []),
    claimEvidenceMatrixPath: ".qwen-harness/proof/claim-evidence-matrix.md",
    blockingIssues,
    residualGaps: [],
    nextAction: goalAchieved ? "final_response_allowed" : "create_correction_package"
  };
  writeJson(paths.finalGate, finalGate);
  writeFileSync(paths.finalReview, finalReviewMarkdown(finalGate), "utf8");
  if (goalAchieved) updatePhase({ cwd, phase: "completed", nextAction: "Final response is allowed." });
  else updatePhase({ cwd, phase: "final_gate", nextAction: "Resolve blocking final proof issues." });
  appendEvent(paths.events, { type: "final_gate_checked", at: finalGate.checkedAt, verdict, goalAchieved });
  return { ok: true, finalGate };
}

export function summarizeEvaluation(options = {}) {
  const root = resolve(options.scanRoot ?? options.cwd ?? process.cwd());
  const projectCwds = options.scanRoot
    ? discoverHarnessCwds(root, Number(options.maxDepth ?? 3))
    : [resolve(options.cwd ?? process.cwd())];
  const projects = projectCwds
    .map((projectCwd) => summarizeEvaluationProject(projectCwd))
    .filter(Boolean);
  const aggregate = aggregateEvaluationProjects(projects);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    scanRoot: options.scanRoot ? root : null,
    projectCount: projects.length,
    aggregate,
    recommendation: evaluationRecommendation(aggregate),
    projects
  };
}

export async function runHookCli({ stdin = process.stdin, stdout = process.stdout, cwd = process.cwd() } = {}) {
  const input = await readAll(stdin);
  const payload = input.trim() ? JSON.parse(input) : {};
  const output = dispatchNativeHook(payload, { cwd });
  if (output) stdout.write(`${JSON.stringify(output)}\n`);
}

export function dispatchNativeHook(payload = {}, options = {}) {
  const cwd = resolve(stringValue(payload.cwd) || options.cwd || process.cwd());
  const eventName = normalizeHookEventName(payload);
  const paths = nativeHybridPaths({ cwd });
  const active = existsSync(paths.state);

  if (eventName === "UserPromptSubmit") {
    return handleUserPromptSubmit(payload, { cwd, active });
  }
  if (!active) return null;

  switch (eventName) {
    case "SessionStart":
      return contextOutput({ cwd, hookEventName: "SessionStart" });
    case "PreToolUse":
      return evaluatePreToolUse(payload, { cwd });
    case "PostToolUse":
      appendEvent(paths.events, { type: "post_tool_use", at: new Date().toISOString(), tool: payload.tool_name ?? payload.toolName ?? payload.tool ?? null });
      return null;
    case "PreCompact":
    case "PostCompact":
      return contextOutput({ cwd, hookEventName: eventName, compact: true });
    case "Stop":
      return evaluateStop({ cwd });
    default:
      return null;
  }
}

export function evaluatePreToolUse(payload = {}, { cwd = process.cwd() } = {}) {
  const toolName = stringValue(payload.tool_name ?? payload.toolName ?? payload.tool).trim();
  const lowerToolName = toolName.toLowerCase();
  const input = objectValue(payload.tool_input ?? payload.toolInput ?? payload.input);
  const paths = extractToolPaths(lowerToolName, input);

  if (paths.some((path) => isProtectedPath(path))) {
    return block("Protected path mutation is blocked.");
  }

  if (MUTATION_TOOLS.has(lowerToolName)) {
    if (paths.length > 0 && paths.every((path) => isStatePath(path, cwd))) return null;
    return block("Codex direct product mutation is blocked during hybrid-run.");
  }

  if (lowerToolName === "bash") {
    const command = stringValue(input.command).trim();
    if (!command) return null;
    if (isHarnessWorkerCommand(command) || isReadOnlyInspection(command) || isAllowedVerificationCommand(command, cwd)) return null;
    if (isDestructiveCommand(command)) return block("Destructive Bash is blocked before final proof gate.");
    if (hasMutationIntent(command)) return block("Mutation Bash is blocked. Use an implementation or correction package and a local Qwen worker.");
  }

  return null;
}

export function evaluateStop({ cwd = process.cwd() } = {}) {
  const paths = nativeHybridPaths({ cwd });
  const status = loadHybridStatus({ cwd });
  if (!status.active) return null;
  if (status.activeWorker) return block(`Local Qwen worker is still active: ${status.activeWorker.workerRunId}`);
  if (!planReviewReady(paths.planReview)) return block("plan-review.md is missing or does not contain verdict: READY.");
  const finalGate = readJson(paths.finalGate);
  if (!finalGate?.goalAchieved) return block("final-gate.json is missing or goalAchieved is not true.");
  if (Array.isArray(finalGate.blockingIssues) && finalGate.blockingIssues.length > 0) {
    return block("final-gate.json still has blocking issues.");
  }
  return null;
}

function handleUserPromptSubmit(payload, { cwd, active }) {
  const prompt = stringValue(payload.prompt ?? payload.user_prompt ?? payload.userPrompt).trim();
  if (!prompt) return active ? contextOutput({ cwd, hookEventName: "UserPromptSubmit" }) : null;
  if (!active && isHybridRunPrompt(prompt)) {
    const result = initHybridRun({ cwd, task: prompt });
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `Initialized Codex-native qwen hybrid harness in ${result.stateDir}. Codex owns design/review/final gates; Pi only launches local Qwen workers. Next action: ${result.nextAction}`
      }
    };
  }
  if (active) return contextOutput({ cwd, hookEventName: "UserPromptSubmit" });
  return null;
}

function contextOutput({ cwd, hookEventName, compact = false }) {
  const status = loadHybridStatus({ cwd });
  if (!status.active) return null;
  const lines = compact
    ? [`Active qwen harness: phase=${status.phase}, package=${status.currentPackageId ?? "none"}, correction=${status.currentCorrectionId ?? "none"}.`]
    : [
        `Active qwen harness: phase=${status.phase}, runtimeOwner=${status.runtimeOwner}, workerTransport=${status.workerTransport}.`,
        "Codex owns design, package verification, correction packages, final proof gate, and goal-achieved judgment.",
        "Codex must not directly mutate product source/test/config during an active hybrid-run.",
        `Next action: ${status.nextAction ?? "inspect .qwen-harness/progress.md"}`
      ];
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: lines.join("\n")
    }
  };
}

function updatePhase({ cwd, phase, nextAction }) {
  if (!PHASES.includes(phase)) throw new Error(`unknown phase: ${phase}`);
  const paths = nativeHybridPaths({ cwd });
  const now = new Date().toISOString();
  const state = readJson(paths.state) ?? {};
  const progress = readJson(paths.progress) ?? {};
  const policy = readJson(paths.policy) ?? defaultPolicy({ activePhase: phase });
  state.phase = phase;
  state.updatedAt = now;
  progress.phase = phase;
  progress.updatedAt = now;
  if (nextAction) progress.nextAction = nextAction;
  policy.activePhase = phase;
  policy.activeOwner = ownerForPhase(phase);
  writeJson(paths.state, state);
  writeJson(paths.progress, progress);
  writeFileSync(paths.progressMarkdown, progressMarkdown(progress), "utf8");
  writeJson(paths.policy, policy);
}

function defaultPolicy({ localWorkerModel = DEFAULT_LOCAL_MODEL, modelRoutes = DEFAULT_MODEL_ROUTES, activePhase = "scout_prepare" } = {}) {
  return {
    version: 1,
    mode: "enforced",
    runtimeOwner: "codex-native",
    workerTransport: "pi",
    canonicalStateDir: CANONICAL_STATE_DIR,
    activePhase,
    activeOwner: ownerForPhase(activePhase),
    localWorkerModel,
    localModelRoutes: modelRoutes,
    codexMayWriteState: true,
    codexMayMutateProductFiles: false,
    localWorkerMayMutateProductFiles: true,
    piMayOwnHarnessState: false,
    allowedCodexWriteGlobs: [".qwen-harness/**"],
    allowedCodexBashPrefixes: [
      "git status",
      "git diff",
      "git diff --",
      "git ls-files",
      "rg ",
      "grep ",
      "find ",
      "ls ",
      "cat ",
      "sed -n ",
      "node --check",
      "npm test",
      "npm run ",
      "qwen-harness-codex ",
      "pi "
    ],
    workerEvidenceRequiredForProductDiff: true,
    requirePlanReviewReady: true,
    requireFinalProofGate: true,
    protectedPaths: [
      ".env",
      ".env.*",
      "**/.env",
      "**/.env.*",
      ".git/**",
      "**/*secret*",
      "**/*credential*",
      "**/*token*"
    ]
  };
}

function ownerForPhase(phase) {
  if (["scout_worker", "package_implementation", "correction_worker"].includes(phase)) return "local-qwen-worker";
  return "codex-native";
}

function implementationPackageMarkdown({ packageId, title, goal, verificationCommand }) {
  return `# Implementation Package ${packageId}: ${title}

- Package ID: ${packageId}
- Owner: local-qwen-worker
- Transport: pi
- Status: pending
- Depends on: []
- Risk: medium

## Goal

${goal}

## Non-goals

- Do not change architecture outside this package.
- Do not alter requirements or final approval rules.

## Files likely involved

- Worker must scout relevant files before editing.

## Decisions that must not be changed

Reference \`.qwen-harness/decisions.md\`.

## Acceptance criteria

### AC1

- Description: The package goal is implemented with evidence.
- Evidence type: unit
- Verification contract:
  - Command: ${verificationCommand.length ? verificationCommand.join(" ") : "not supplied"}
  - Expected result: Command exits 0 and exercises the changed behavior.
- Source evidence expected: Changed source and test paths.
- Runtime evidence expected: Verification output.
- Adversarial probe: Include one negative or edge-case check where applicable.
- Reentry/idempotency probe: Rerun verification without extra changes.

## Worker instructions

- Implement only this package.
- Do not change architecture.
- Do not change requirements.
- If the package appears wrong, stop and write a blocker.
- Run the verification command.
- Repair failures within the assigned package only.

## Hard stops

- Requirement ambiguity
- Public API/schema change not in package
- Protected path required
- Destructive command required
- Repeated same failure after repair attempts
`;
}

function correctionPackageMarkdown({ correctionId, targetPackageId, reviewPath, reviewText }) {
  return `# Correction Package ${correctionId} for ${targetPackageId}

- Correction ID: ${correctionId}
- Target package: ${targetPackageId}
- Source review: ${stateRelative(reviewPath)}
- Owner: local-qwen-worker
- Transport: pi

## Failed claims

| Claim | Failure evidence | Required correction |
| --- | --- | --- |
| Review findings | See source review below | Repair the specific failed claim without broadening scope. |

## Codex diagnosis

${reviewText.slice(0, 4000)}

## Required changes

1. Fix only the failed claim from the package review.
2. Re-run the package verification contract and update evidence.

## Prohibited changes

- Do not broaden the architecture.
- Do not rewrite unrelated files.
- Do not bypass tests.
- Do not convert behavioral tests into smoke tests.

## Verification contract

- Command: use the package verification command.
- Expected result: Command exits 0 with source and runtime evidence.
- Additional adversarial probe: Cover the failed behavior.
- Reentry/idempotency probe: Rerun verification without further edits.

## Stop conditions

- If correction requires changing package scope, stop.
- If test failure contradicts the package design, stop.
- If repeated repair loops fail with the same signature, stop.
`;
}

function workerPrompt({ packageId, correctionId, attempt, packagePath, evidencePath, verificationCommand, packageMarkdown }) {
  return `# Local Qwen Worker Handoff

You are a local implementation worker called by the Codex native hybrid harness.

## Role boundary

- You are not the planner.
- You are not the final verifier.
- You do not decide whether the goal is achieved.
- Codex native owns design, package review, correction package generation, and final proof gate.
- Pi is only the transport that launched you.

## Assigned work

- Package: ${packageId}
- Correction: ${correctionId ?? "none"}
- Attempt: ${attempt}
- Package file: ${stateRelative(packagePath)}
- Evidence output: ${stateRelative(evidencePath)}

## Hard constraints

- Implement only the assigned package or correction.
- Do not change architecture or requirements.
- Do not modify protected paths.
- Do not use destructive commands.
- If the package is wrong or insufficient, stop and write a blocker.
- If the same failure repeats without new evidence, stop.

## Required outputs

Write compact evidence to:

\`${stateRelative(evidencePath)}\`

Include files read, files changed, commands run, exit codes, test output path, source evidence, runtime evidence, adversarial probe result, reentry/idempotency probe result, residual gaps, and blockers.

## Verification command

\`\`\`sh
${verificationCommand.length ? verificationCommand.join(" ") : "No verification command supplied"}
\`\`\`

## Package

${packageMarkdown}
`;
}

function localReviewPrompt({ packageId, packagePath, evidencePath }) {
  return `# Local Qwen Supplemental Review

You are a read-only local reviewer for the Codex native hybrid harness.

## Role boundary

- Do not modify files.
- Do not decide final approval; Codex native owns the final gate.
- Review implementation evidence for concrete bugs, missing tests, and contract gaps.
- Prefer concise findings with exact files and commands to rerun.

## Review target

- Package: ${packageId}
- Package file: ${stateRelative(packagePath)}
- Evidence file: ${evidencePath ? stateRelative(evidencePath) : "not available"}

## Required output

Start with exactly one line:

\`VERDICT: PASS\` or \`VERDICT: REQUEST_CHANGES\`

Then list only actionable findings. If no blocking issue exists, say why the evidence is sufficient.
`;
}

function taskMarkdown({ title, task, taskId, runId, verificationCommand }) {
  return `# ${title}

- Task ID: ${taskId}
- Run ID: ${runId}
- Harness: Codex-native hybrid-run
- State directory: \`${CANONICAL_STATE_DIR}/\`
- Verification command: ${verificationCommand.length ? `\`${verificationCommand.join(" ")}\`` : "not supplied"}

## User task

${task}
`;
}

function requirementsMarkdown({ task, verificationCommand }) {
  return `# Requirements

## Captured task

${task}

## Verification contract

${verificationCommand.length ? `- Command: \`${verificationCommand.join(" ")}\`` : "- Command: not supplied"}
- Expected result: Must be made executable before package implementation starts.

## Acceptance evidence policy

- Source evidence and runtime evidence must be recorded separately.
- Behavioral acceptance cannot be satisfied by smoke evidence only.
- Adversarial and reentry probes are required where applicable.
`;
}

function scoutHandoffMarkdown({ task, taskId, runId, verificationCommand }) {
  return `# Scout Handoff

- Task ID: ${taskId}
- Run ID: ${runId}
- Owner: local-qwen-worker
- Transport: pi

## Scout goal

Map the repository areas relevant to this task without making product changes.

## Task

${task}

## Verification command

${verificationCommand.length ? verificationCommand.join(" ") : "not supplied"}

## Required output

Write a compact scout summary to \`.qwen-harness/scout/scout-evidence.json\` and \`.qwen-harness/scout/repo-map.md\`.
`;
}

function progressMarkdown(progress) {
  return `# Qwen Harness Progress

- Phase: ${progress.phase}
- Task: ${progress.title ?? progress.taskId ?? "unknown"}
- Current package: ${progress.currentPackageId ?? "none"}
- Current correction: ${progress.currentCorrectionId ?? "none"}
- Next action: ${progress.nextAction ?? "none"}
- Updated: ${progress.updatedAt}
`;
}

function verificationMarkdown(result) {
  return `# Package Review ${result.packageId}

- Verdict: ${result.verdict}
- Attempt: ${result.attemptId ?? "none"}
- Reviewed at: ${result.reviewedAt}
- Next action: ${result.nextAction}

## Claims

${result.claims.map((claim) => `- ${claim.verdict}: ${claim.claim} (${claim.evidenceType})`).join("\n") || "- No claims."}

## Blocking Issues

${result.blockingIssues.map((issue) => `- ${issue}`).join("\n") || "- None"}

## Required Corrections

${result.requiredCorrections.map((item) => `- ${item}`).join("\n") || "- None"}
`;
}

function claimEvidenceMatrixMarkdown(reviews) {
  const rows = ["| Package | Claim | Verdict | Evidence type | Residual gap |", "| --- | --- | --- | --- | --- |"];
  for (const review of reviews) {
    for (const claim of review.claims ?? []) {
      rows.push(`| ${review.packageId} | ${escapeTable(claim.claim)} | ${claim.verdict} | ${claim.evidenceType} | ${escapeTable(claim.residualGap ?? "")} |`);
    }
  }
  return `# Claim Evidence Matrix

${rows.join("\n")}
`;
}

function finalReviewMarkdown(finalGate) {
  return `# Final Review

- Verdict: ${finalGate.verdict}
- Goal achieved: ${finalGate.goalAchieved}
- Checked at: ${finalGate.checkedAt}
- Next action: ${finalGate.nextAction}

## Blocking Issues

${finalGate.blockingIssues.map((issue) => `- ${issue}`).join("\n") || "- None"}
`;
}

function localReviewMarkdown(review) {
  return `# Local Review ${review.reviewId}

- Package: ${review.packageId}
- Model: ${review.model}
- Status: ${review.status}
- Verdict: ${review.verdict}
- Local tokens: ${review.tokenUsage?.local?.total ?? 0}

## Review

${review.reviewText || "No review text was captured."}
`;
}

function workerSummary(evidence) {
  return `# Worker Summary

- Worker run: ${evidence.workerRunId}
- Package: ${evidence.packageId ?? "none"}
- Correction: ${evidence.correctionId ?? "none"}
- Status: ${evidence.status}
- Transport: ${evidence.transport}
- Files changed: ${(evidence.filesChanged ?? []).length}
- Local tokens: ${evidence.tokenUsage?.local?.total ?? 0}
`;
}

function buildClaimsFromEvidence(evidence) {
  if (!evidence) {
    return [{
      claim: "Package evidence exists",
      verdict: "unknown",
      evidence: [],
      evidenceType: "static",
      whatWouldFailIfBroken: "No worker run evidence can be reviewed.",
      residualGap: "Worker evidence missing."
    }];
  }
  const normalizedEvidence = normalizeWorkerEvidence(evidence);
  const acceptance = normalizeAcceptanceEvidence(normalizedEvidence.acceptanceEvidence);
  if (acceptance.length > 0) {
    return acceptance.map((item, index) => ({
      claim: `${item.acceptanceId ?? `AC${index + 1}`} is satisfied`,
      verdict: item.status === "claimed_passed" ? "pass" : item.status === "blocked" ? "unknown" : "fail",
      evidence: [...(item.sourceEvidence ?? []), ...(item.runtimeEvidence ?? [])],
      evidenceType: inferEvidenceType(item),
      whatWouldFailIfBroken: "The package verification contract would fail.",
      residualGap: (item.residualGaps ?? []).join("; ")
    }));
  }
  const commands = Array.isArray(normalizedEvidence.commandsRun) ? normalizedEvidence.commandsRun : [];
  const commandPassed = commands.some((command) => command.exitCode === 0);
  const changedFiles = Array.isArray(normalizedEvidence.filesChanged) ? normalizedEvidence.filesChanged : [];
  const residualRisks = Array.isArray(normalizedEvidence.residualRisks) ? normalizedEvidence.residualRisks : [];
  const completed = normalizeWorkerEvidenceStatus(normalizedEvidence.status, normalizedEvidence.status) === "completed";
  return [
    {
      claim: "Worker completed package run",
      verdict: completed && commandPassed ? "pass" : "unknown",
      evidence: commands,
      evidenceType: commandPassed ? "runtime" : "static",
      whatWouldFailIfBroken: "Worker command exits non-zero or reports blockers.",
      residualGap: completed && commandPassed ? "" : "No completed runtime evidence."
    },
    {
      claim: "Changed product files are recorded",
      verdict: changedFiles.length > 0 ? "pass" : "fail",
      evidence: changedFiles,
      evidenceType: "static",
      whatWouldFailIfBroken: "Recovered or incomplete runs could pass without source evidence.",
      residualGap: changedFiles.length > 0 ? "" : "filesChanged is empty."
    },
    {
      claim: "Structured acceptance evidence exists",
      verdict: "fail",
      evidence: [],
      evidenceType: "static",
      whatWouldFailIfBroken: "Runtime pass could hide missing acceptance, adversarial, or reentry proof.",
      residualGap: "acceptanceEvidence is empty."
    },
    {
      claim: "No residual risk is admitted by worker evidence",
      verdict: residualRisks.length === 0 ? "pass" : "fail",
      evidence: residualRisks,
      evidenceType: "static",
      whatWouldFailIfBroken: "Recovered or partial evidence could be treated as final proof.",
      residualGap: residualRisks.join("; ")
    }
  ];
}

function inferEvidenceType(item) {
  if ((item.runtimeEvidence ?? []).length > 0) return "runtime";
  if ((item.sourceEvidence ?? []).length > 0) return "static";
  return "smoke";
}

function appendVerificationResult(path, result) {
  const payload = readJson(path) ?? { version: 1, reviews: [] };
  payload.reviews = Array.isArray(payload.reviews) ? payload.reviews.filter((review) => review.packageId !== result.packageId) : [];
  payload.reviews.push(result);
  writeJson(path, payload);
}

function findLatestEvidence(workerRunsDir, packageId) {
  if (!existsSync(workerRunsDir)) return null;
  const names = safeReadDir(workerRunsDir).filter((name) => name.includes(packageId)).sort();
  for (const name of names.reverse()) {
    const evidence = readJson(join(workerRunsDir, name, "evidence.json"));
    if (evidence) return normalizeWorkerEvidence(evidence);
  }
  return null;
}

function discoverHarnessCwds(root, maxDepth) {
  const found = [];
  const limit = Number.isFinite(maxDepth) && maxDepth >= 0 ? maxDepth : 3;
  visit(resolve(root), 0);
  return [...new Set(found)].sort();

  function visit(dir, depth) {
    if (existsSync(join(dir, CANONICAL_STATE_DIR, "state.json"))) {
      found.push(dir);
      return;
    }
    if (depth >= limit) return;
    for (const name of safeReadDir(dir)) {
      if ([".git", "node_modules", "dist", "build", ".next", ".codex"].includes(name)) continue;
      const path = join(dir, name);
      try {
        if (lstatSync(path).isDirectory()) visit(path, depth + 1);
      } catch {
        // Ignore unreadable scan entries.
      }
    }
  }
}

function summarizeEvaluationProject(cwd) {
  const paths = nativeHybridPaths({ cwd });
  if (!existsSync(paths.state)) return null;
  const state = readJson(paths.state) ?? {};
  const metrics = readJsonl(paths.metrics);
  const evidenceRuns = collectWorkerEvidence(paths.workerRunsDir);
  const localReviews = collectLocalReviews(paths.localReviewsDir);
  const runs = mergeMetricAndEvidenceRuns({ metrics, evidenceRuns, localReviews });
  const verificationResults = readJson(paths.verificationResults) ?? { reviews: [] };
  const packageReviews = Array.isArray(verificationResults.reviews) ? verificationResults.reviews : [];
  const finalGate = readJson(paths.finalGate) ?? null;
  return {
    cwd,
    taskId: state.taskId ?? null,
    title: state.title ?? state.taskId ?? null,
    phase: state.phase ?? null,
    modelRoutes: state.models?.routes ?? null,
    runs: runs.map((run) => ({
      workerRunId: run.workerRunId,
      kind: run.kind,
      role: run.role,
      model: run.model,
      status: run.status,
      durationMs: numberValue(run.durationMs),
      tokenUsage: run.tokenUsage ?? emptyTokenUsage(),
      filesChangedCount: numberValue(run.filesChangedCount),
      providerPreflight: run.providerPreflight ? {
        ok: run.providerPreflight.ok,
        targetModel: run.providerPreflight.targetModel,
        targetRunning: run.providerPreflight.targetRunning,
        blockers: run.providerPreflight.blockers ?? []
      } : null
    })),
    runSummary: summarizeRuns(runs),
    packageReviews: packageReviews.map((review) => ({
      packageId: review.packageId,
      verdict: review.verdict,
      claimCount: Array.isArray(review.claims) ? review.claims.length : 0,
      blockingIssues: review.blockingIssues ?? []
    })),
    localReviews: localReviews.map((review) => ({
      reviewId: review.reviewId,
      packageId: review.packageId,
      model: review.model,
      verdict: review.verdict,
      status: review.status,
      tokenUsage: review.tokenUsage ?? emptyTokenUsage()
    })),
    finalGate: finalGate ? {
      verdict: finalGate.verdict,
      goalAchieved: finalGate.goalAchieved,
      blockingIssues: finalGate.blockingIssues ?? []
    } : null,
    failedEvidence: evidenceRuns
      .filter((run) => run.status && run.status !== "completed" && run.status !== "dry-run")
      .map((run) => ({
        workerRunId: run.workerRunId,
        model: run.model,
        status: run.status,
        blockers: run.blockers ?? [],
        providerPreflight: run.providerPreflight ? {
          ok: run.providerPreflight.ok,
          targetModel: run.providerPreflight.targetModel,
          targetRunning: run.providerPreflight.targetRunning,
          blockers: run.providerPreflight.blockers ?? []
        } : null
      }))
  };
}

function collectWorkerEvidence(workerRunsDir) {
  if (!existsSync(workerRunsDir)) return [];
  return safeReadDir(workerRunsDir)
    .map((name) => readJson(join(workerRunsDir, name, "evidence.json")))
    .map((value) => normalizeWorkerEvidence(value))
    .filter((value) => value && typeof value === "object");
}

function collectLocalReviews(localReviewsDir) {
  if (!existsSync(localReviewsDir)) return [];
  return safeReadDir(localReviewsDir)
    .map((name) => readJson(join(localReviewsDir, name, "review.json")))
    .filter((value) => value && typeof value === "object");
}

function mergeMetricAndEvidenceRuns({ metrics, evidenceRuns, localReviews }) {
  const runs = Array.isArray(metrics) ? [...metrics] : [];
  const seen = new Set(runs.map((run) => run.workerRunId).filter(Boolean));
  for (const evidence of evidenceRuns) {
    if (!evidence.workerRunId || seen.has(evidence.workerRunId)) continue;
    runs.push(metricFromEvidence(evidence));
    seen.add(evidence.workerRunId);
  }
  for (const review of localReviews) {
    if (!review.reviewId || seen.has(review.reviewId)) continue;
    runs.push({
      version: 1,
      at: review.completedAt ?? null,
      workerRunId: review.reviewId,
      kind: "review",
      role: "review",
      model: review.model,
      status: review.status,
      durationMs: 0,
      tokenUsage: review.tokenUsage ?? emptyTokenUsage(),
      filesChanged: [],
      filesChangedCount: 0,
      exitCode: review.status === "completed" ? 0 : null,
      providerPreflight: review.providerPreflight ?? null
    });
    seen.add(review.reviewId);
  }
  return runs;
}

function metricFromEvidence(evidence) {
  const normalized = normalizeWorkerEvidence(evidence);
  return {
    version: 1,
    at: normalized.completedAt ?? null,
    workerRunId: normalized.workerRunId,
    kind: normalized.phase === "scout_worker" ? "scout" : normalized.phase === "correction_worker" ? "correction" : "package",
    role: normalized.phase === "scout_worker" ? "scout" : normalized.phase === "correction_worker" ? "correction" : "implementation",
    model: normalized.model,
    status: normalized.status,
    durationMs: durationBetween(normalized.startedAt, normalized.completedAt),
    tokenUsage: normalized.tokenUsage ?? emptyTokenUsage(),
    filesChanged: normalized.filesChanged ?? [],
    filesChangedCount: Array.isArray(normalized.filesChanged) ? normalized.filesChanged.length : 0,
    exitCode: Array.isArray(normalized.commandsRun) ? normalized.commandsRun.find((command) => command.exitCode !== undefined)?.exitCode ?? null : null,
    providerPreflight: normalized.providerPreflight ?? null
  };
}

function summarizeRuns(runs) {
  const summary = {
    totalRuns: runs.length,
    completed: 0,
    failed: 0,
    blocked: 0,
    dryRun: 0,
    durationMs: 0,
    tokenUsage: emptyTokenUsage(),
    byModel: {},
    byRole: {},
    providerPreflightFailures: 0
  };
  for (const run of runs) {
    const status = run.status ?? "unknown";
    if (status === "completed" || status === "recovered:completed") summary.completed += 1;
    else if (status === "dry-run") summary.dryRun += 1;
    else if (status === "blocked") summary.blocked += 1;
    else summary.failed += 1;
    summary.durationMs += numberValue(run.durationMs);
    summary.tokenUsage = mergeTokenUsage(summary.tokenUsage, run.tokenUsage);
    if (run.providerPreflight && run.providerPreflight.ok === false) summary.providerPreflightFailures += 1;
    addGroupedRun(summary.byModel, run.model ?? "unknown", run);
    addGroupedRun(summary.byRole, run.role ?? run.kind ?? "unknown", run);
  }
  summary.successRate = summary.totalRuns > 0 ? summary.completed / summary.totalRuns : 0;
  return summary;
}

function addGroupedRun(target, key, run) {
  const bucket = target[key] ?? {
    totalRuns: 0,
    completed: 0,
    failed: 0,
    durationMs: 0,
    tokenUsage: emptyTokenUsage(),
    filesChangedCount: 0,
    providerPreflightFailures: 0
  };
  bucket.totalRuns += 1;
  if (run.status === "completed" || run.status === "recovered:completed") bucket.completed += 1;
  else if (run.status !== "dry-run") bucket.failed += 1;
  bucket.durationMs += numberValue(run.durationMs);
  bucket.tokenUsage = mergeTokenUsage(bucket.tokenUsage, run.tokenUsage);
  bucket.filesChangedCount += numberValue(run.filesChangedCount);
  if (run.providerPreflight && run.providerPreflight.ok === false) bucket.providerPreflightFailures += 1;
  bucket.successRate = bucket.totalRuns > 0 ? bucket.completed / bucket.totalRuns : 0;
  target[key] = bucket;
}

function aggregateEvaluationProjects(projects) {
  const runs = projects.flatMap((project) => project.runs ?? []);
  const approvedProjectRuns = projects
    .filter((project) => project.finalGate?.verdict === "APPROVE")
    .flatMap((project) => project.runs ?? []);
  const completedRuns = runs.filter((run) => run.status === "completed" || run.status === "recovered:completed");
  const failedRuns = runs.filter((run) => run.status && run.status !== "completed" && run.status !== "recovered:completed" && run.status !== "dry-run");
  const runSummary = summarizeRuns(runs);
  const approvedRunSummary = summarizeRuns(approvedProjectRuns);
  const completedRunSummary = summarizeRuns(completedRuns);
  const failedRunSummary = summarizeRuns(failedRuns);
  const aggregate = {
    totalProjects: projects.length,
    approvedProjects: projects.filter((project) => project.finalGate?.verdict === "APPROVE").length,
    projectsWithBlockingFinalGate: projects.filter((project) => project.finalGate && project.finalGate.verdict !== "APPROVE").length,
    totalPackageReviews: projects.reduce((sum, project) => sum + project.packageReviews.length, 0),
    passingPackageReviews: projects.reduce((sum, project) => sum + project.packageReviews.filter((review) => review.verdict === "PASS").length, 0),
    totalLocalReviews: projects.reduce((sum, project) => sum + project.localReviews.length, 0),
    passingLocalReviews: projects.reduce((sum, project) => sum + project.localReviews.filter((review) => review.verdict === "PASS").length, 0),
    runSummary,
    failurePatterns: collectFailurePatterns(projects)
  };
  aggregate.lowerBoundLocalTokensOffloaded = aggregate.runSummary.tokenUsage.local.total;
  aggregate.tokenAccounting = {
    lowerBoundLocalTokensOffloaded: aggregate.runSummary.tokenUsage.local.total,
    approvedProjectLocalTokensOffloaded: approvedRunSummary.tokenUsage.local.total,
    completedRunLocalTokensOffloaded: completedRunSummary.tokenUsage.local.total,
    failedRunLocalTokensSpent: failedRunSummary.tokenUsage.local.total,
    frontierTokensSpent: aggregate.runSummary.tokenUsage.frontier.total,
    note: "Local token totals are a lower-bound estimate of frontier tokens avoided when the same prompts would otherwise have run in Codex/frontier context."
  };
  return aggregate;
}

function collectFailurePatterns(projects) {
  const patterns = {};
  for (const project of projects) {
    for (const item of project.failedEvidence ?? []) {
      for (const blocker of item.blockers ?? []) {
        const key = String(blocker).slice(0, 160);
        patterns[key] = (patterns[key] ?? 0) + 1;
      }
      for (const blocker of item.providerPreflight?.blockers ?? []) {
        const key = `provider: ${String(blocker).slice(0, 160)}`;
        patterns[key] = (patterns[key] ?? 0) + 1;
      }
    }
  }
  return Object.entries(patterns)
    .sort((a, b) => b[1] - a[1])
    .map(([pattern, count]) => ({ pattern, count }));
}

function evaluationRecommendation(aggregate) {
  const byModel = aggregate.runSummary?.byModel ?? {};
  const implementationModel = normalizeProviderModel(DEFAULT_IMPLEMENTATION_MODEL);
  const reviewModel = normalizeProviderModel(DEFAULT_REVIEW_MODEL);
  return {
    recommendedRoutes: DEFAULT_MODEL_ROUTES,
    rationale: [
      `${implementationModel} remains the default implementation/correction route because completed implementation evidence exists on code-heavy/browser tasks and the user reports stronger coding ability.`,
      `${reviewModel} remains the default scout/review route because supplemental review catches evidence-contract problems and produces useful audit findings.`,
      "Use provider preflight for every live worker. Model switching is allowed by default so the role's intended model is used; set --disallow-model-switch only for explicitly non-evicting diagnostic runs."
    ],
    observedModels: Object.fromEntries(Object.entries(byModel).map(([model, bucket]) => [model, {
      runs: bucket.totalRuns,
      successRate: bucket.successRate,
      localTokens: bucket.tokenUsage?.local?.total ?? 0,
      providerPreflightFailures: bucket.providerPreflightFailures ?? 0
    }]))
  };
}

function durationBetween(startedAt, completedAt) {
  const start = Date.parse(startedAt ?? "");
  const end = Date.parse(completedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function safeReadDir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function resolveWorkerPackagePath({ paths, kind, packageId, correctionId }) {
  if (kind === "scout") return paths.scoutHandoff;
  if (kind === "correction") {
    const matches = findPackageFiles(paths.correctionPackagesDir, `${correctionId ?? "C"}-for-${packageId ?? ""}`);
    if (matches[0]) return matches[0];
  }
  if (packageId) return join(paths.implementationPackagesDir, `${packageId}.md`);
  throw new Error("worker requires --package, --correction, or --kind scout");
}

function findPackageFiles(dir, prefix) {
  if (!existsSync(dir)) return [];
  return safeReadDir(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".md"))
    .sort()
    .map((name) => join(dir, name));
}

function markActiveWorker({ cwd, workerRunId, packageId, correctionId, kind, runDir, model }) {
  const paths = nativeHybridPaths({ cwd });
  const ownership = readJson(paths.ownership) ?? {};
  ownership.activeWorker = {
    workerRunId,
    packageId: packageId ?? null,
    correctionId: correctionId ?? null,
    kind,
    runDir: stateRelative(runDir),
    model,
    startedAt: new Date().toISOString()
  };
  writeJson(paths.ownership, ownership);
  updatePhase({
    cwd,
    phase: kind === "scout" ? "scout_worker" : kind === "correction" ? "correction_worker" : "package_implementation",
    nextAction: `Worker ${workerRunId} ${kind === "package" ? "is implementing" : "is running"}.`
  });
}

function clearActiveWorker({ cwd, workerRunId, status }) {
  const paths = nativeHybridPaths({ cwd });
  const ownership = readJson(paths.ownership) ?? {};
  if (ownership.activeWorker?.workerRunId === workerRunId) {
    ownership.lastWorker = { ...ownership.activeWorker, status, completedAt: new Date().toISOString() };
    ownership.activeWorker = null;
    writeJson(paths.ownership, ownership);
  }
}

function updatePackageList({ cwd, packageId, status }) {
  const paths = nativeHybridPaths({ cwd });
  const ownership = readJson(paths.ownership) ?? {};
  ownership.packages = Array.isArray(ownership.packages) ? ownership.packages.filter((item) => item.packageId !== packageId) : [];
  ownership.packages.push({ packageId, status, updatedAt: new Date().toISOString() });
  writeJson(paths.ownership, ownership);
  const plan = readJson(paths.implementationPlan) ?? { version: 1, packages: [] };
  plan.packages = Array.isArray(plan.packages) ? plan.packages.filter((item) => item.packageId !== packageId) : [];
  plan.packages.push({ packageId, status });
  writeJson(paths.implementationPlan, plan);
}

function updateCorrectionList({ cwd, correctionId, targetPackageId, status }) {
  const paths = nativeHybridPaths({ cwd });
  const ownership = readJson(paths.ownership) ?? {};
  ownership.corrections = Array.isArray(ownership.corrections) ? ownership.corrections.filter((item) => item.correctionId !== correctionId) : [];
  ownership.corrections.push({ correctionId, targetPackageId, status, updatedAt: new Date().toISOString() });
  writeJson(paths.ownership, ownership);
}

function workerRunIdFor({ kind, packageId, correctionId, attempt }) {
  if (kind === "scout") return `scout-attempt-${attempt}`;
  if (correctionId) return `${correctionId}-for-${packageId}-attempt-${attempt}`;
  return `${packageId}-attempt-${attempt}`;
}

function workerRoleForKind(kind) {
  if (kind === "scout") return "scout";
  if (kind === "correction") return "correction";
  return "implementation";
}

function defaultModelForWorker({ cwd, kind }) {
  return defaultModelForRole({ cwd, role: workerRoleForKind(kind) });
}

function defaultModelForRole({ cwd, role }) {
  const paths = nativeHybridPaths({ cwd });
  const state = readJson(paths.state) ?? {};
  const policy = readJson(paths.policy) ?? {};
  const routes = state.models?.routes ?? policy.localModelRoutes ?? DEFAULT_MODEL_ROUTES;
  return routes[role] ?? DEFAULT_MODEL_ROUTES[role] ?? DEFAULT_LOCAL_MODEL;
}

function isHybridRunPrompt(prompt) {
  return /\bhybrid-run\b|\bqwen-first\b|\blocal worker\b|토큰 절약|pi\/qwen으로 구현/i.test(prompt);
}

function normalizeHookEventName(payload) {
  return stringValue(payload.hook_event_name ?? payload.hookEventName ?? payload.event_name ?? payload.eventName).trim();
}

function extractToolPaths(toolName, input) {
  const directPath = stringValue(input.file_path ?? input.filePath ?? input.path ?? input.file).trim();
  if (directPath) return [directPath];
  if (toolName !== "apply_patch") return [];

  const textFields = [
    input.command,
    input.patch,
    input.diff,
    input.text,
    input.content,
    input.input
  ].filter((value) => typeof value === "string" && value.trim());
  const text = textFields.length ? textFields.join("\n") : JSON.stringify(input);
  return extractPatchPaths(text);
}

function extractPatchPaths(text) {
  const paths = [];
  const addPath = (value) => {
    const path = String(value ?? "").trim();
    if (!path || path === "/dev/null") return;
    paths.push(path.replace(/^([ab])\//, ""));
  };
  for (const line of String(text).split(/\r?\n/)) {
    const patchHeader = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s+(.+)$/.exec(line);
    if (patchHeader) {
      addPath(patchHeader[1]);
      continue;
    }
    const diffHeader = /^(?:---|\+\+\+)\s+(?:(?:a|b)\/)?(.+)$/.exec(line);
    if (diffHeader) addPath(diffHeader[1]);
  }
  return [...new Set(paths)];
}

function isProtectedPath(path) {
  const normalized = path.replace(/\\/g, "/");
  const base = basename(normalized).toLowerCase();
  return base === ".env"
    || base.startsWith(".env.")
    || normalized.startsWith(".git/")
    || normalized.includes("/.git/")
    || /secret|credential|token/i.test(normalized);
}

function isStatePath(path, cwd) {
  const absolute = resolve(cwd, path);
  const stateRoot = resolve(cwd, CANONICAL_STATE_DIR);
  const rel = relative(stateRoot, absolute);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isHarnessWorkerCommand(command) {
  return /(?:^|\s)(?:qwen-harness-codex|node\s+\S*qwen-harness-codex\.mjs)\s+(?:worker|hybrid-run|hybrid-resume|hybrid-status|verify-package|create-correction|final-gate|recover-worker|local-review|autonomous-run|autonomous-lite|autonomous-validate|validate-autonomous)\b/.test(command)
    || /(?:^|\s)pi\s+.*--no-session\s+.*--model\s+(?:local-qwen|llama-local)\//.test(command);
}

function isReadOnlyInspection(command) {
  return /^(?:git status|git diff(?:\s|$)|git ls-files|rg\s|grep\s|find\s|ls\s|cat\s|sed -n\s|node --check\b)/.test(command.trim());
}

function isAllowedVerificationCommand(command, cwd) {
  const phase = loadHybridStatus({ cwd }).phase;
  return /^(?:npm test|npm run |pnpm test|yarn test|bun test|node --test|pytest|cargo test|go test)\b/.test(command.trim())
    && ["package_verification", "correction_verification", "final_gate", "completed", "blocked"].includes(phase);
}

function isDestructiveCommand(command) {
  return /(?:^|[;&|]\s*)(?:sudo\b|rm\s+-rf\b|git\s+reset\s+--hard\b|git\s+clean\s+-fdx\b|git\s+checkout\s+--\b|git\s+commit\b)/.test(command);
}

export function hasMutationIntent(command) {
  const trimmed = command.trim();
  return /\bapply_patch\b/.test(trimmed)
    || /(?:^|[;&|]\s*)(?:cat|printf|echo)\b[\s\S]{0,240}>\s*[^\s&|;]+/.test(trimmed)
    || /\btee\s+(?:-a\s+)?[^\s&|;]+/.test(trimmed)
    || /\bsed\s+(?:[^\n;&|]*\s)?-i(?:\b|['"])/.test(trimmed)
    || /\b(?:python3?|node|perl|ruby)\b[\s\S]{0,360}\b(?:writeFileSync|writeFile|write_text|open\([^)]*["']w|File\.write|Path\()/.test(trimmed);
}

function block(reason) {
  return { decision: "block", reason, systemMessage: reason };
}

function planReviewReady(path) {
  if (!existsSync(path)) return false;
  return /\bverdict\s*:?\s*READY\b/i.test(readFileSync(path, "utf8"));
}

function ensureActiveHarness(paths) {
  if (!existsSync(paths.state)) throw new Error(`No active ${CANONICAL_STATE_DIR}/state.json found.`);
}

function emptyTokenUsage() {
  return {
    frontier: { input: 0, output: 0, total: 0 },
    local: { input: 0, output: 0, total: 0 },
    unknown: { input: 0, output: 0, total: 0 }
  };
}

function normalizeCommand(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.trim().split(/\s+/);
  return [];
}

function defaultVerificationCommand(paths) {
  const progressCommand = normalizeCommand(readJson(paths.progress)?.verificationCommand);
  if (progressCommand.length) return progressCommand;
  const planCommand = normalizeCommand(readJson(paths.implementationPlan)?.verificationCommand);
  if (planCommand.length) return planCommand;
  return [];
}

function nextNumberedId(dir, prefix) {
  let index = 1;
  const names = new Set(safeReadDir(dir));
  while ([...names].some((name) => name.startsWith(`${prefix}${String(index).padStart(3, "0")}`))) index += 1;
  return `${prefix}${String(index).padStart(3, "0")}`;
}

function slugify(value) {
  const slug = String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "task";
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function stateRelative(path) {
  const normalized = String(path).replace(/\\/g, "/");
  const marker = `${CANONICAL_STATE_DIR}/`;
  const index = normalized.indexOf(marker);
  if (index >= 0) return normalized.slice(index);
  return normalized;
}

function escapeTable(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function parseMaybeBoolean(value) {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === false) return value;
  if (/^(true|1|yes|on)$/i.test(String(value))) return true;
  if (/^(false|0|no|off)$/i.test(String(value))) return false;
  return undefined;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function readAutonomousTaskText(options = {}) {
  const taskFile = stringValue(options.taskFile).trim();
  if (taskFile) return readFileSync(resolve(taskFile), "utf8");
  const task = requiredString(options.task, "task");
  const maybePath = resolve(task);
  if (existsSync(maybePath) && !lstatSync(maybePath).isDirectory()) return readFileSync(maybePath, "utf8");
  return task;
}

function ensureAutonomousProjectDir(projectDir, allowExisting) {
  mkdirSync(projectDir, { recursive: true });
  const entries = safeReadDir(projectDir).filter((name) => name !== AUTONOMOUS_STATE_DIR);
  if (!allowExisting && entries.length > 0) {
    throw new Error(`Project directory is not empty: ${projectDir}. Use --allow-existing to reuse it.`);
  }
}

function autonomousRequiredFiles({ command, requiredFiles }) {
  const required = Array.isArray(requiredFiles)
    ? requiredFiles.map(String).filter(Boolean)
    : normalizeCommand(requiredFiles);
  if (command[0] === "npm" && !required.includes("package.json")) required.push("package.json");
  return required;
}

function autonomousPrompt({ taskText, projectDir, commandText, minTests, evidenceFile, maxInternalLoops }) {
  return `# Qwen Autonomous Lite Contract

You are the implementation worker. Codex will not read your full logs or write corrections.
You must complete the implementation, test loop, and compact evidence by yourself.

## Working directory boundary

- Your current working directory is the project root:
  ${projectDir}
- Create and edit files only inside this directory.
- Do not create files in the benchmark/spec directory.
- Do not create or modify files outside the current working directory.
- Use relative paths in evidence.

## Required execution loop

1. Inspect the current project directory.
2. Implement the requested project.
3. Run this verification command exactly:

\`\`\`sh
${commandText}
\`\`\`

4. If verification fails, or if the test count is less than ${minTests}, fix the code and rerun.
5. Repeat internally up to ${maxInternalLoops} test/fix loops.
6. Run the verification command one final time.

## Required evidence

Write compact final evidence to \`${evidenceFile}\` at the project root.
The evidence must be valid JSON with this shape:

\`\`\`json
{
  "status": "passed",
  "summary": "one concise paragraph",
  "testCommand": "${commandText}",
  "tests": { "pass": 0, "fail": 0, "total": 0 },
  "changedFiles": ["relative/path"],
  "commands": [{ "command": "${commandText}", "exitCode": 0 }],
  "risks": ["remaining risk, or none"]
}
\`\`\`

Rules:
- Set \`status\` to \`"passed"\` only when the final verification command exits 0 and test total is at least ${minTests}.
- Set \`status\` to \`"failed"\` if you cannot complete the work.
- Keep evidence short. Do not paste source files or long logs.
- Do not ask Codex for intermediate review.

## Task

${taskText.trim()}
`;
}

function autonomousRepairPrompt({ validation, commandText, minTests, evidenceFile, maxInternalLoops }) {
  return `# Qwen Autonomous Lite Repair

You are repairing your own implementation inside the current project directory.
Codex is only providing the compact validation result below and will not read full logs.

## Validation failure

\`\`\`json
${JSON.stringify(validation, null, 2)}
\`\`\`

## Repair requirements

- Edit only files inside the current project directory.
- Fix the specific validation failures.
- Run \`${commandText}\`.
- If it fails, repair and rerun up to ${maxInternalLoops} loops.
- Update \`${evidenceFile}\` with compact valid JSON.
- \`status\` may be \`"passed"\` only if final verification exits 0 and test total is at least ${minTests}.
- Do not paste source files or long logs in the console.
`;
}

async function runAutonomousPiAttempt({ options, projectDir, runDir, prompt, command, evidenceFile, minTests, requiredFiles }) {
  mkdirSync(runDir, { recursive: true });
  const promptPath = join(runDir, "prompt.md");
  const stdoutPath = join(runDir, "pi.stdout.jsonl");
  const stderrPath = join(runDir, "pi.stderr.log");
  writeFileSync(promptPath, prompt, "utf8");

  const piBinary = options.piBinary ?? "pi";
  const model = options.model ?? DEFAULT_IMPLEMENTATION_MODEL;
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--model",
    model,
    `@${relative(projectDir, promptPath)}`
  ];
  const result = await runPiProcessToFiles({
    command: piBinary,
    args,
    cwd: projectDir,
    stdoutPath,
    stderrPath,
    timeoutMs: positiveNumber(options.timeoutMs, DEFAULT_AUTONOMOUS_TIMEOUT_MS),
    watchdogIntervalMs: positiveNumber(options.watchdogIntervalMs, DEFAULT_WATCHDOG_INTERVAL_MS),
    watchdog: async () => {
      const validation = validateAutonomousProject({
        projectDir,
        command,
        evidenceFile,
        minTests,
        requiredFiles,
        verifyTimeoutMs: options.verifyTimeoutMs
      });
      return validation.status === "passed"
        ? { ready: true, reason: "autonomous evidence passed verification", validation }
        : { ready: false };
    }
  });
  return {
    exitCode: result.exitCode ?? (result.errorMessage ? 1 : 0),
    signal: result.signal ?? null,
    timedOut: result.timedOut,
    watchdogTerminated: result.watchdogTerminated,
    watchdogReason: result.watchdogReason,
    model,
    promptPath,
    stdoutPath,
    stderrPath,
    tokenUsage: parsePiUsageFile(stdoutPath)
  };
}

function runVerificationCommand({ command, cwd, timeoutMs, stdoutPath, stderrPath }) {
  mkdirSync(dirname(stdoutPath), { recursive: true });
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: timeoutMs,
    maxBuffer: DEFAULT_LOG_MAX_BYTES
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? result.error?.message ?? "";
  writeFileSync(stdoutPath, compactLog(stdout, DEFAULT_LOG_MAX_BYTES), "utf8");
  writeFileSync(stderrPath, compactLog(stderr, DEFAULT_LOG_MAX_BYTES), "utf8");
  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    signal: result.signal ?? null,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout,
    stderr
  };
}

async function runPiProcessToFiles({
  command,
  args,
  cwd,
  stdoutPath,
  stderrPath,
  timeoutMs,
  watchdog = null,
  watchdogIntervalMs = DEFAULT_WATCHDOG_INTERVAL_MS
}) {
  mkdirSync(dirname(stdoutPath), { recursive: true });
  mkdirSync(dirname(stderrPath), { recursive: true });
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  const startedAtMs = Date.now();
  let child;
  let settled = false;
  let exitCode = null;
  let signal = null;
  let errorMessage = null;
  let timedOut = false;
  let watchdogTerminated = false;
  let watchdogReason = null;

  const finishPromise = new Promise((resolveFinish) => {
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ["ignore", stdoutFd, stderrFd],
        shell: false
      });
    } catch (error) {
      settled = true;
      exitCode = 1;
      errorMessage = error.message;
      resolveFinish();
      return;
    }
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      exitCode = 1;
      errorMessage = error.message;
      resolveFinish();
    });
    child.on("exit", (code, childSignal) => {
      if (settled) return;
      settled = true;
      exitCode = code;
      signal = childSignal;
      resolveFinish();
    });
  });

  try {
    let nextWatchdogAt = Date.now() + Math.max(1000, Number(watchdogIntervalMs) || DEFAULT_WATCHDOG_INTERVAL_MS);
    while (!settled) {
      const now = Date.now();
      if (Number.isFinite(timeoutMs) && timeoutMs > 0 && now - startedAtMs >= timeoutMs) {
        timedOut = true;
        await terminateChild(child, finishPromise, "SIGTERM");
        if (!settled) await terminateChild(child, finishPromise, "SIGKILL");
        if (!settled) {
          settled = true;
          exitCode = 1;
          signal = "SIGKILL";
        }
        break;
      }

      if (watchdog && now >= nextWatchdogAt) {
        nextWatchdogAt = now + Math.max(1000, Number(watchdogIntervalMs) || DEFAULT_WATCHDOG_INTERVAL_MS);
        let watchdogResult = null;
        try {
          watchdogResult = await watchdog({ pid: child?.pid ?? null, elapsedMs: now - startedAtMs });
        } catch {
          watchdogResult = null;
        }
        if (watchdogResult?.ready) {
          watchdogTerminated = true;
          watchdogReason = watchdogResult.reason ?? "watchdog condition satisfied";
          await terminateChild(child, finishPromise, "SIGTERM");
          if (!settled) await terminateChild(child, finishPromise, "SIGKILL");
          if (!settled) {
            settled = true;
            exitCode = 0;
            signal = "SIGKILL";
          }
          break;
        }
      }

      await delay(Math.min(1000, Math.max(100, nextWatchdogAt - Date.now())));
    }
    if (!settled) await finishPromise;
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }

  return {
    exitCode,
    signal,
    timedOut,
    watchdogTerminated,
    watchdogReason,
    errorMessage,
    pid: child?.pid ?? null,
    durationMs: Math.max(0, Date.now() - startedAtMs)
  };
}

async function terminateChild(child, finishPromise, signal) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    return;
  }
  await Promise.race([finishPromise, delay(DEFAULT_CHILD_SHUTDOWN_GRACE_MS)]);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseAutonomousTestCounts(output) {
  const lastNumberFor = (label) => {
    const matches = [...String(output).matchAll(new RegExp(`^(?:#|ℹ)\\s*${label}\\s+(\\d+)\\s*$`, "gim"))];
    if (!matches.length) return null;
    return Number(matches[matches.length - 1][1]);
  };
  const tapTests = lastNumberFor("tests");
  const tapPass = lastNumberFor("pass");
  const tapFail = lastNumberFor("fail");
  if (tapTests !== null || tapPass !== null || tapFail !== null) {
    return {
      total: tapTests ?? (tapPass ?? 0) + (tapFail ?? 0),
      pass: tapPass,
      fail: tapFail,
      source: "node-test-summary"
    };
  }
  const jestLike = String(output).match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+passed,\s+)?(\d+)\s+total/i);
  if (jestLike) {
    return {
      fail: Number(jestLike[1] || 0),
      pass: Number(jestLike[2] || 0),
      total: Number(jestLike[3]),
      source: "jest-summary"
    };
  }
  const vitestLike = String(output).match(/Test Files\s+\d+\s+passed.*?Tests\s+(\d+)\s+passed/is);
  if (vitestLike) {
    const pass = Number(vitestLike[1]);
    return { total: pass, pass, fail: 0, source: "vitest-summary" };
  }
  return { total: null, pass: null, fail: null, source: "unknown" };
}

function validateAutonomousChangedFiles(evidence, projectDir) {
  const failures = [];
  if (!Array.isArray(evidence.changedFiles)) return ["evidence.changedFiles must be an array"];
  for (const changedFile of evidence.changedFiles) {
    if (typeof changedFile !== "string" || !changedFile.trim()) {
      failures.push(`changedFiles contains invalid entry: ${JSON.stringify(changedFile)}`);
      continue;
    }
    if (isAbsolute(changedFile)) {
      const rel = relative(projectDir, resolve(changedFile));
      if (rel.startsWith("..") || isAbsolute(rel)) failures.push(`changed file is outside project directory: ${changedFile}`);
      continue;
    }
    const normalized = relative(".", changedFile);
    if (normalized.startsWith("..") || isAbsolute(normalized)) failures.push(`relative changed file escapes project directory: ${changedFile}`);
  }
  return failures;
}

function providerUrlFromOptions(options = {}) {
  return options.providerUrl
    ?? options.llamaSwapUrl
    ?? process.env.QWEN_HARNESS_PROVIDER_URL
    ?? process.env.QWEN_HARNESS_LLAMA_SWAP_URL
    ?? process.env.LLAMA_SWAP_URL
    ?? null;
}

function normalizeProviderUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.replace(/\/+$/, "");
}

function normalizeProviderModel(model) {
  return String(model ?? "").trim().replace(/^(?:llama-local|local-qwen)\//, "");
}

function curlJson(options) {
  const result = curlHttp(options);
  if (!result.ok) return { ...result, body: null };
  try {
    return { ...result, body: JSON.parse(result.text || "{}") };
  } catch (error) {
    return { ...result, ok: false, body: null, error: `Invalid JSON: ${error.message}` };
  }
}

function curlHttp({ curlBinary = "curl", url, method = "GET", body = null, timeoutMs = DEFAULT_PROVIDER_STATUS_TIMEOUT_MS }) {
  const startedAtMs = Date.now();
  const timeoutSeconds = Math.max(1, Math.ceil(positiveNumber(timeoutMs, DEFAULT_PROVIDER_STATUS_TIMEOUT_MS) / 1000));
  const args = ["-sS", "-m", String(timeoutSeconds), "-w", "\n__QWEN_HTTP_STATUS__:%{http_code}"];
  if (method !== "GET") args.push("-X", method);
  if (body !== null) args.push("-H", "Content-Type: application/json", "-d", JSON.stringify(body));
  args.push(url);
  const result = spawnSync(curlBinary, args, {
    encoding: "utf8",
    shell: false,
    timeout: timeoutSeconds * 1000 + 1000,
    maxBuffer: 4 * 1024 * 1024
  });
  const stdout = result.stdout ?? "";
  const match = /\n__QWEN_HTTP_STATUS__:(\d{3})\s*$/.exec(stdout);
  const text = match ? stdout.slice(0, match.index) : stdout;
  const statusCode = match ? Number(match[1]) : null;
  const error = result.error?.message || result.stderr?.trim() || null;
  return {
    ok: result.status === 0 && statusCode !== null && statusCode >= 200 && statusCode < 300,
    statusCode,
    text,
    error,
    durationMs: Math.max(0, Date.now() - startedAtMs)
  };
}

function summarizeHttpResult(result) {
  return {
    ok: result.ok,
    statusCode: result.statusCode,
    durationMs: result.durationMs,
    text: String(result.text ?? "").slice(0, 200),
    error: result.error
  };
}

function snapshotWorkspace(cwd) {
  const root = resolve(cwd);
  const entries = new Map();
  visit(root);
  return entries;

  function visit(dir) {
    for (const name of safeReadDir(dir)) {
      if ([".git", ".qwen-harness", "node_modules", "dist", "build", ".next"].includes(name)) continue;
      const path = join(dir, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!stat.isFile()) continue;
      const relativePath = relative(root, path).replace(/\\/g, "/");
      entries.set(relativePath, hashFile(path));
    }
  }
}

function hashFile(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "unreadable";
  }
}

function diffSnapshots(before, after) {
  const changed = [];
  for (const [path, hash] of after.entries()) {
    if (before.get(path) !== hash) changed.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.push(path);
  }
  return [...new Set(changed)].sort();
}

function objectToSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = new Map();
  for (const [path, hash] of Object.entries(value)) {
    if (typeof path === "string" && typeof hash === "string") entries.set(path, hash);
  }
  return entries;
}

function inferRecoveredStatus(runDir) {
  const testOutput = existsSync(join(runDir, "test-output.log")) ? readFileSync(join(runDir, "test-output.log"), "utf8") : "";
  if (/\bfail\s+0\b/i.test(testOutput) && /\bpass\s+[1-9]\d*\b/i.test(testOutput)) return "completed";
  return "failed";
}

function recoveredCommands(runDir) {
  const testOutputPath = join(runDir, "test-output.log");
  if (!existsSync(testOutputPath) || !readFileSync(testOutputPath, "utf8").trim()) return [];
  return [{
    command: "recovered verification output",
    exitCode: /\bfail\s+0\b/i.test(readFileSync(testOutputPath, "utf8")) ? 0 : null,
    outputPath: stateRelative(testOutputPath),
    summary: "Recovered from test-output.log after launcher interruption."
  }];
}

function parsePiUsage(stdout) {
  const usage = emptyTokenUsage();
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    parsePiUsageLine(line, usage);
  }
  return usage;
}

function parsePiUsageFile(path) {
  const usage = emptyTokenUsage();
  if (!path || !existsSync(path)) return usage;
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(64 * 1024);
  let carry = "";
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      const chunk = `${carry}${buffer.subarray(0, bytesRead).toString("utf8")}`;
      const lines = chunk.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) parsePiUsageLine(line, usage);
    }
    if (carry.trim()) parsePiUsageLine(carry, usage);
  } finally {
    closeSync(fd);
  }
  return usage;
}

function parsePiUsageLine(line, usage) {
  if (!String(line ?? "").trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const messageUsage = event?.message?.usage
    ?? event?.usage
    ?? event?.assistantMessageEvent?.partial?.usage
    ?? event?.response?.usage
    ?? event?.data?.usage;
  if (!messageUsage || typeof messageUsage !== "object") return;
  const input = numberValue(messageUsage.input ?? messageUsage.inputTokens ?? messageUsage.prompt_tokens ?? messageUsage.promptTokens);
  const output = numberValue(messageUsage.output ?? messageUsage.outputTokens ?? messageUsage.completion_tokens ?? messageUsage.completionTokens);
  const total = numberValue(messageUsage.totalTokens ?? messageUsage.total ?? messageUsage.total_tokens ?? input + output);
  usage.local.input = Math.max(usage.local.input, input);
  usage.local.output = Math.max(usage.local.output, output);
  usage.local.total = Math.max(usage.local.total, total);
}

function extractFinalAssistantText(stdout) {
  let latest = "";
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const message = event?.message ?? event?.assistantMessageEvent?.partial;
    if (message?.role !== "assistant") continue;
    const text = contentText(message.content);
    if (text.trim()) latest = text;
  }
  return latest.trim();
}

function extractToolExecutions(stdout) {
  const executions = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "tool_execution_end") continue;
    const output = toolResultText(event.result);
    executions.push({
      toolName: event.toolName ?? null,
      command: event.args?.command ?? event.toolCall?.arguments?.command ?? event.toolName ?? "tool execution",
      output,
      exitCode: inferExitCode(output, event.isError)
    });
  }
  return executions;
}

function toolResultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.map((item) => typeof item === "string" ? item : item?.text ?? "").join("");
}

function inferExitCode(output, isError) {
  const match = /EXIT_CODE=(\d+)/.exec(String(output ?? ""));
  if (match) return Number(match[1]);
  if (isError) return 1;
  if (/\bfail\s+0\b/i.test(String(output ?? ""))) return 0;
  return null;
}

function synthesizeAcceptanceEvidence({ changedFiles, toolExecutions, verificationCommand, runDir }) {
  const verificationRuns = toolExecutions.filter((execution) => {
    const command = String(execution.command ?? "");
    const output = String(execution.output ?? "");
    return command.includes(verificationCommand.join(" "))
      || /\bfail\s+0\b/i.test(output)
      || /\bpass\s+[1-9]\d*\b/i.test(output);
  });
  const passingRuns = verificationRuns.filter((execution) => execution.exitCode === 0 || /\bfail\s+0\b/i.test(execution.output));
  if (passingRuns.length === 0) return [];
  return [{
    acceptanceId: "AC1",
    status: "claimed_passed",
    sourceEvidence: Array.isArray(changedFiles) ? changedFiles : [],
    runtimeEvidence: [stateRelative(join(runDir, "test-output.log"))],
    adversarialProbes: inferProbeDescriptions(passingRuns.map((run) => run.output).join("\n")),
    reentryProbes: passingRuns.length > 1 ? ["Verification was run more than once without additional harness-side changes."] : [],
    residualGaps: []
  }];
}

function inferProbeDescriptions(output) {
  const probes = [];
  if (/zero|0,?\s*999|negative|-2/i.test(output)) probes.push("Verification output includes zero/negative edge-case coverage.");
  if (/pass\s+[1-9]\d*|✔/i.test(output)) probes.push("Verification suite passed after implementation.");
  return probes.length ? probes : ["Verification output passed the assigned test suite."];
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => typeof item === "string" ? item : item?.text ?? "").join("");
}

function inferReviewVerdict(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const verdictLine = lines.slice(0, 12).find((line) => /VERDICT\s*:/i.test(line)) ?? "";
  if (/VERDICT\s*:\s*(?:\*\*)?PASS/i.test(verdictLine)) return "PASS";
  if (/VERDICT\s*:\s*(?:\*\*)?REQUEST[_\s-]?CHANGES/i.test(verdictLine)) return "REQUEST_CHANGES";
  if (/\b(blocking|bug|fail|missing|incorrect|request changes)\b/i.test(text)) return "REQUEST_CHANGES";
  return "PASS";
}

function normalizeWorkerEvidenceStatus(status, fallback) {
  const text = String(status ?? "").trim().toLowerCase();
  if (["completed", "blocked", "failed", "dry-run"].includes(text)) return text;
  if (["passed", "pass", "success", "ok", "done", "complete"].includes(text)) return "completed";
  if (["fail", "error", "errored"].includes(text)) return "failed";
  return fallback;
}

function normalizeWorkerEvidence(evidence, context = {}) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return evidence;
  const normalizedCommands = Array.isArray(evidence.commandsRun) && evidence.commandsRun.length
    ? evidence.commandsRun
    : Array.isArray(evidence.commands) && evidence.commands.length
      ? evidence.commands.map((command) => ({
          command: command.command ?? command.cmd ?? String(command),
          exitCode: command.exitCode ?? command.code ?? null,
          outputPath: command.outputPath ?? command.logPath ?? null,
          summary: command.summary ?? undefined
        }))
      : evidence.commandsRun;
  const filesChanged = mergeUnique(
    evidence.filesChanged,
    evidence.changedFiles,
    evidence.files_changed,
    context.filesChanged
  );
  const acceptance = normalizeAcceptanceEvidence(evidence.acceptanceEvidence);
  const rawAcceptance = acceptance.length ? acceptance : acceptanceEvidenceFromRawEvidence({
    ...evidence,
    filesChanged,
    commandsRun: normalizedCommands
  });
  const tokenUsage = context.parsedUsage
    ? preferMeasuredTokenUsage(evidence.tokenUsage, context.parsedUsage)
    : evidence.tokenUsage ?? emptyTokenUsage();
  return {
    ...evidence,
    workerRunId: evidence.workerRunId ?? context.workerRunId ?? null,
    packageId: evidence.packageId ?? evidence.package ?? context.packageId ?? null,
    correctionId: evidence.correctionId ?? context.correctionId ?? null,
    status: normalizeWorkerEvidenceStatus(evidence.status, context.fallbackStatus ?? evidence.status),
    filesChanged,
    commandsRun: normalizedCommands ?? [],
    acceptanceEvidence: rawAcceptance,
    tokenUsage
  };
}

function acceptanceEvidenceFromRawEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return [];
  const sourceEvidence = normalizeEvidenceList(evidence.sourceEvidence ?? evidence.source_evidence ?? evidence.filesChanged ?? evidence.changedFiles);
  const runtimeEvidence = normalizeEvidenceList(
    evidence.runtimeEvidence
      ?? evidence.runtime_evidence
      ?? evidence.testOutputPath
      ?? evidence.testOutput
      ?? evidence.commandsRun
      ?? evidence.commands
  );
  const adversarialProbes = normalizeEvidenceList(evidence.adversarialProbe ?? evidence.adversarialProbes ?? evidence.adversarial_probe);
  const reentryProbes = normalizeEvidenceList(
    evidence.reentryIdempotencyProbe
      ?? evidence.reentryIdempotencyProbes
      ?? evidence.reentryProbe
      ?? evidence.reentryProbes
      ?? evidence.idempotencyProbe
  );
  const residualGaps = normalizeEvidenceList(evidence.residualGaps ?? evidence.residualRisks ?? evidence.risks);
  const commands = Array.isArray(evidence.commandsRun) ? evidence.commandsRun : [];
  const commandPassed = commands.some((command) => Number(command?.exitCode) === 0);
  const status = normalizeWorkerEvidenceStatus(evidence.status, evidence.status);
  const hasSourceAndRuntime = sourceEvidence.length > 0 && (runtimeEvidence.length > 0 || commandPassed);
  if (!sourceEvidence.length && !runtimeEvidence.length && !adversarialProbes.length && !reentryProbes.length && !commandPassed) return [];
  return [{
    acceptanceId: "AC1",
    status: status === "completed" && hasSourceAndRuntime ? "claimed_passed" : "failed",
    sourceEvidence,
    runtimeEvidence,
    adversarialProbes,
    reentryProbes,
    residualGaps
  }];
}

function normalizeAutonomousEvidence(evidence, { commandText } = {}) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return evidence;
  const commands = Array.isArray(evidence.commands) ? evidence.commands : Array.isArray(evidence.commandsRun) ? evidence.commandsRun : [];
  const firstCommand = commands.find((command) => command?.command !== undefined)?.command;
  const commandFromEvidence = evidence.testCommand
    ?? (Array.isArray(firstCommand) ? firstCommand.join(" ") : typeof firstCommand === "string" ? firstCommand : null)
    ?? evidence.command
    ?? null;
  return {
    ...evidence,
    status: normalizeAutonomousStatus(evidence.status),
    testCommand: commandFromEvidence,
    tests: evidence.tests ?? evidence.testResults ?? evidence.testSummary ?? {},
    changedFiles: Array.isArray(evidence.changedFiles)
      ? evidence.changedFiles
      : Array.isArray(evidence.filesChanged)
        ? evidence.filesChanged
        : []
  };
}

function normalizeAutonomousStatus(status) {
  const text = String(status ?? "").trim().toLowerCase();
  if (["passed", "pass", "success", "ok", "completed", "complete", "done"].includes(text)) return "passed";
  if (["failed", "fail", "error", "blocked"].includes(text)) return "failed";
  return text || status;
}

function workerEvidenceReadyForWatchdog(evidencePath) {
  const evidence = normalizeWorkerEvidence(readJson(evidencePath));
  if (!evidence) return { ready: false };
  if (normalizeWorkerEvidenceStatus(evidence.status, evidence.status) !== "completed") return { ready: false };
  const commands = Array.isArray(evidence.commandsRun) ? evidence.commandsRun : [];
  const commandPassed = commands.some((command) => Number(command?.exitCode) === 0);
  const acceptance = normalizeAcceptanceEvidence(evidence.acceptanceEvidence);
  const acceptancePassed = acceptance.length > 0 && acceptance.every((item) => item.status === "claimed_passed");
  return commandPassed || acceptancePassed
    ? { ready: true, reason: "worker evidence completed with passing command or acceptance evidence" }
    : { ready: false };
}

function normalizeCommandsRun(commandsRun, { piBinary, piCommand, exitCode, runDir, options, toolExecutions = [] }) {
  if (Array.isArray(commandsRun) && commandsRun.length > 0) return commandsRun;
  if (toolExecutions.length > 0) {
    return toolExecutions.map((execution) => ({
      command: execution.command,
      exitCode: execution.exitCode,
      outputPath: stateRelative(join(runDir, "test-output.log")),
      summary: execution.exitCode === 0 ? "Tool command passed." : "Tool command completed."
    }));
  }
  return [
    {
      command: [piBinary, ...piCommand.args.slice(0, 6), "<worker prompt>"].join(" "),
      exitCode,
      outputPath: stateRelative(join(runDir, "stdout.log")),
      summary: options.live ? "Pi worker invocation finished." : "Dry-run prepared Pi worker artifacts."
    }
  ];
}

function normalizeAcceptanceEvidence(value) {
  if (Array.isArray(value)) return value.map((item, index) => normalizeAcceptanceItem(item, item?.acceptanceId ?? `AC${index + 1}`));
  if (value && typeof value === "object") {
    if ("status" in value || "sourceEvidence" in value || "runtimeEvidence" in value) {
      return [normalizeAcceptanceItem(value, value.acceptanceId ?? "AC1")];
    }
    return Object.entries(value).map(([acceptanceId, entry]) => {
      const item = entry && typeof entry === "object" ? entry : { description: String(entry) };
      return normalizeAcceptanceItem(item, acceptanceId);
    });
  }
  return [];
}

function normalizeAcceptanceItem(item, acceptanceId) {
  const entry = item && typeof item === "object" ? item : { description: String(item ?? "") };
  return {
    ...entry,
    acceptanceId: entry.acceptanceId ?? acceptanceId,
    status: normalizeAcceptanceStatus(entry.status, entry),
    sourceEvidence: normalizeEvidenceList(entry.sourceEvidence),
    runtimeEvidence: normalizeEvidenceList(entry.runtimeEvidence),
    residualGaps: normalizeEvidenceList(entry.residualGaps ?? entry.residualGap ?? entry.residualRisks)
  };
}

function normalizeAcceptanceStatus(status, entry = {}) {
  const text = String(status ?? "").trim();
  if (/^(?:claimed_)?pass(?:ed)?$/i.test(text)) return "claimed_passed";
  if (/^(?:block|blocked|unknown|skipped)$/i.test(text)) return "blocked";
  if (/^(?:fail|failed|request_changes)$/i.test(text)) return "failed";
  if (!text && acceptanceEntryLooksPassed(entry)) return "claimed_passed";
  return text || "failed";
}

function acceptanceEntryLooksPassed(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (Number(entry.exitCode) === 0) return true;
  if (Number(entry.testsFailed) === 0 && Number(entry.testsPassed) > 0) return true;
  const values = [
    entry.result,
    entry.runtimeEvidence?.result,
    entry.adversarialProbe?.result,
    entry.reentryIdempotencyProbe?.result,
    entry.reentryProbe?.result
  ].map((value) => String(value ?? ""));
  return values.some((value) => /^pass(?:ed)?$/i.test(value));
}

function normalizeEvidenceList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => normalizeEvidenceList(item));
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (value === undefined || value === null) return [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => {
      if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
        return [`${key}: ${entry}`];
      }
      const nested = normalizeEvidenceList(entry);
      return nested.length ? nested.map((item) => `${key}: ${item}`) : [];
    });
  }
  return [];
}

function readCompactFile(path, maxBytes = DEFAULT_LOG_MAX_BYTES) {
  if (!path || !existsSync(path)) return "";
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_LOG_MAX_BYTES;
  const stat = lstatSync(path);
  if (!stat.isFile()) return "";
  if (stat.size <= limit) return readFileSync(path, "utf8");
  const half = Math.floor(limit / 2);
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    const headBytes = readSync(fd, head, 0, half, 0);
    const tailBytes = readSync(fd, tail, 0, half, Math.max(0, stat.size - half));
    return [
      head.subarray(0, headBytes).toString("utf8"),
      `\n\n[log compacted by qwen-harness-codex: originalBytes=${stat.size}, retainedBytes~=${limit}]\n\n`,
      tail.subarray(0, tailBytes).toString("utf8")
    ].join("");
  } finally {
    closeSync(fd);
  }
}

function compactLog(value, maxBytes) {
  const text = String(value ?? "");
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_LOG_MAX_BYTES;
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const half = Math.floor(limit / 2);
  const head = Buffer.from(text).subarray(0, half).toString("utf8");
  const tail = Buffer.from(text).subarray(-half).toString("utf8");
  return [
    head,
    `\n\n[log compacted by qwen-harness-codex: originalBytes=${Buffer.byteLength(text, "utf8")}, retainedBytes~=${limit}]\n\n`,
    tail
  ].join("");
}

function mergeTokenUsage(existing, usage) {
  const next = emptyTokenUsage();
  for (const bucket of ["frontier", "local", "unknown"]) {
    next[bucket] = {
      input: numberValue(existing?.[bucket]?.input) + numberValue(usage?.[bucket]?.input),
      output: numberValue(existing?.[bucket]?.output) + numberValue(usage?.[bucket]?.output),
      total: numberValue(existing?.[bucket]?.total) + numberValue(usage?.[bucket]?.total)
    };
  }
  return next;
}

function preferMeasuredTokenUsage(existing, usage) {
  const next = emptyTokenUsage();
  for (const bucket of ["frontier", "local", "unknown"]) {
    const measured = usage?.[bucket];
    const fallback = existing?.[bucket];
    const source = tokenBucketHasValue(measured) ? measured : fallback;
    next[bucket] = {
      input: numberValue(source?.input),
      output: numberValue(source?.output),
      total: numberValue(source?.total)
    };
  }
  return next;
}

function tokenBucketHasValue(bucket) {
  return numberValue(bucket?.input) > 0 || numberValue(bucket?.output) > 0 || numberValue(bucket?.total) > 0;
}

function updateAggregateTokenUsage({ cwd, usage }) {
  const paths = nativeHybridPaths({ cwd });
  for (const path of [paths.progress, paths.state]) {
    const payload = readJson(path);
    if (!payload) continue;
    payload.tokenUsage = mergeTokenUsage(payload.tokenUsage, usage);
    writeJson(path, payload);
  }
}

function runMetric({ workerRunId, kind, role, model, status, startedAtMs, tokenUsage, filesChanged, exitCode, providerPreflight = null, watchdogTerminated = false }) {
  const endedAtMs = Date.now();
  return {
    version: 1,
    at: new Date(endedAtMs).toISOString(),
    workerRunId,
    kind,
    role,
    model,
    status,
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    tokenUsage: tokenUsage ?? emptyTokenUsage(),
    filesChanged: Array.isArray(filesChanged) ? filesChanged : [],
    filesChangedCount: Array.isArray(filesChanged) ? filesChanged.length : 0,
    exitCode,
    watchdogTerminated,
    providerPreflight: providerPreflight ? {
      ok: providerPreflight.ok,
      targetModel: providerPreflight.targetModel,
      targetRunning: providerPreflight.targetRunning,
      probe: providerPreflight.probe,
      blockers: providerPreflight.blockers ?? []
    } : null
  };
}

function appendMetric(path, metric) {
  appendEvent(path, metric);
}

function mergeUnique(...lists) {
  return [...new Set(lists.flatMap((list) => Array.isArray(list) ? list : []).filter((value) => typeof value === "string" && value.trim()))].sort();
}

function numberValue(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function readJson(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendEvent(path, event) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verification-command") {
      opts.verificationCommand = argv.slice(index + 1);
      break;
    }
    if (arg === "--live") opts.live = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--cwd") opts.cwd = argv[++index];
    else if (arg === "--project") opts.project = argv[++index];
    else if (arg === "--task") opts.task = argv[++index];
    else if (arg === "--task-file") opts.taskFile = argv[++index];
    else if (arg === "--task-id") opts.taskId = argv[++index];
    else if (arg === "--run-id") opts.runId = argv[++index];
    else if (arg === "--title") opts.title = argv[++index];
    else if (arg === "--model") opts.model = argv[++index];
    else if (arg === "--implementation-model") opts.implementationModel = argv[++index];
    else if (arg === "--correction-model") opts.correctionModel = argv[++index];
    else if (arg === "--scout-model") opts.scoutModel = argv[++index];
    else if (arg === "--review-model") opts.reviewModel = argv[++index];
    else if (arg === "--review-id") opts.reviewId = argv[++index];
    else if (arg === "--package") opts.packageId = argv[++index];
    else if (arg === "--package-id") opts.packageId = argv[++index];
    else if (arg === "--correction") opts.correctionId = argv[++index];
    else if (arg === "--correction-id") opts.correctionId = argv[++index];
    else if (arg === "--attempt") opts.attempt = argv[++index];
    else if (arg === "--review") opts.review = argv[++index];
    else if (arg === "--goal") opts.goal = argv[++index];
    else if (arg === "--instructions") opts.instructions = argv[++index];
    else if (arg === "--goal-achieved") opts.goalAchieved = argv[++index];
    else if (arg === "--kind") opts.kind = argv[++index];
    else if (arg === "--timeout-ms") opts.timeoutMs = argv[++index];
    else if (arg === "--verify-timeout-ms") opts.verifyTimeoutMs = argv[++index];
    else if (arg === "--provider-timeout-ms") opts.providerTimeoutMs = argv[++index];
    else if (arg === "--max-age-ms") opts.maxAgeMs = argv[++index];
    else if (arg === "--watchdog-interval-ms") opts.watchdogIntervalMs = argv[++index];
    else if (arg === "--status") opts.status = argv[++index];
    else if (arg === "--max-buffer") opts.maxBuffer = argv[++index];
    else if (arg === "--max-log-bytes") opts.maxLogBytes = argv[++index];
    else if (arg === "--min-tests") opts.minTests = argv[++index];
    else if (arg === "--repair-attempts") opts.repairAttempts = argv[++index];
    else if (arg === "--max-internal-loops") opts.maxInternalLoops = argv[++index];
    else if (arg === "--evidence-file") opts.evidenceFile = argv[++index];
    else if (arg === "--job-id") opts.jobId = argv[++index];
    else if (arg === "--require-file") {
      opts.requiredFiles ??= [];
      opts.requiredFiles.push(argv[++index]);
    }
    else if (arg === "--allow-existing") opts.allowExisting = true;
    else if (arg === "--detached") opts.detached = true;
    else if (arg === "--background") opts.background = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--validate-only") opts.validateOnly = true;
    else if (arg === "--pi-binary") opts.piBinary = argv[++index];
    else if (arg === "--curl-binary") opts.curlBinary = argv[++index];
    else if (arg === "--provider-url") opts.providerUrl = argv[++index];
    else if (arg === "--llama-swap-url") opts.llamaSwapUrl = argv[++index];
    else if (arg === "--scan-root") opts.scanRoot = argv[++index];
    else if (arg === "--max-depth") opts.maxDepth = argv[++index];
    else if (arg === "--provider-probe") opts.providerProbe = true;
    else if (arg === "--probe") opts.probe = true;
    else if (arg === "--allow-model-switch") opts.allowModelSwitch = true;
    else if (arg === "--disallow-model-switch") opts.allowModelSwitch = false;
    else positional.push(arg);
  }
  return { command: positional[0] ?? "help", opts };
}

async function main(argv = process.argv.slice(2)) {
  const { command, opts } = parseArgs(argv);
  const print = (value) => console.log(JSON.stringify(value, null, 2));
  switch (command) {
    case "hybrid-run":
    case "new-task":
      print(initHybridRun(opts));
      break;
    case "hybrid-resume":
    case "hybrid-status":
    case "native-status":
    case "status":
      print(loadHybridStatus(opts));
      break;
    case "create-package":
    case "implementation-package":
      print(createImplementationPackage(opts));
      break;
    case "worker":
    case "spawn-worker":
      print(await spawnWorker(opts));
      break;
    case "recover-worker":
    case "recover-active-worker":
      print(recoverActiveWorker(opts));
      break;
    case "local-review":
    case "review-worker":
      print(runLocalReview(opts));
      break;
    case "model-health":
    case "provider-health":
      print(checkLlamaSwapProvider(opts));
      break;
    case "evaluation-report":
    case "evaluation-summary":
    case "benchmark-summary":
      print(summarizeEvaluation(opts));
      break;
    case "autonomous-run":
    case "autonomous-lite":
      print(await runAutonomous(opts));
      break;
    case "autonomous-status":
    case "autonomous-job-status":
      print(autonomousJobStatus(opts));
      break;
    case "autonomous-validate":
    case "validate-autonomous":
      print(await runAutonomous({ ...opts, validateOnly: true }));
      break;
    case "verify-package":
      print(verifyPackage(opts));
      break;
    case "create-correction":
    case "correction-package":
      print(createCorrectionPackage(opts));
      break;
    case "final-gate":
      print(runFinalGate(opts));
      break;
    case "codex-native-hook":
      await runHookCli();
      break;
    case "help":
    case "--help":
    case "-h":
      console.log("qwen-harness-codex hybrid-run|hybrid-status|worker|recover-worker|local-review|model-health|evaluation-report|autonomous-run|autonomous-status|autonomous-validate|verify-package|create-correction|final-gate|codex-native-hook");
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fileURLToPath(import.meta.url)).href && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    updateAutonomousJobFromEnv({ status: "failed", error: error.message });
    console.error(`qwen-harness-codex: ${error.message}`);
    process.exit(1);
  });
}

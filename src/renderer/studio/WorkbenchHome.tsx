import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { WorkflowLlmConfig } from "@graph/types.ts";
import type { AuthUser } from "../auth.ts";
import { firstPublishIssue } from "@graph/validate.ts";
import { ExecutionCenter } from "./ExecutionCenter.tsx";
import type { DryRunState } from "@runner/dry-run.ts";
import { applyParentVersionUpdate, executeCascadingParentVersionUpdates, executeParentVersionUpdates, hasRedactedSecrets, planParentVersionUpdates, type ParentVersionUpdate } from "./dependency-bulk-update.ts";
import {
  RPA_SERVICE_URL,
  archiveWorkflow,
  copyWorkflow,
  createWorkspace,
  deleteWorkspace,
  createLlmConfig,
  deleteLlmConfig,
  deleteWorkflowPermanently,
  exportWorkflowPackage,
  getWorkflowDependencies,
  getWorkflowRevision,
  getWorkflow,
  importWorkflowPackage,
  loadSubflowBundle,
  listLlmConfigs,
  listWorkspaces,
  listWorkflowRevisions,
  listWorkflows,
  moveWorkflow,
  publishWorkflow,
  previewWorkflowPackage,
  testLlmConfig,
  updateLlmConfig,
  updateWorkspace,
  updateWorkflow,
  type LlmConfigItem,
  type WorkflowListItem,
  type WorkflowPackage,
  type WorkflowPackagePreview,
  type WorkflowDependencies,
  type WorkflowRevisionItem,
  type WorkspaceItem,
} from "../workflow-api.ts";

interface DependencyBulkPreview {
  readonly version: number;
  readonly rows: readonly (ParentVersionUpdate & { readonly publishIssue?: string; readonly parentStatus: string })[];
}

type Module = "workflows" | "executions" | "approvals" | "ai";
export interface WorkflowListViewState {
  readonly page: number;
  readonly query: string;
}
const EMPTY_LLM: WorkflowLlmConfig = {
  id: "",
  name: "",
  enabled: false,
  provider: "openai-compatible",
  model: "",
  baseUrl: "",
  chatPath: "/v1/chat/completions",
  apiKey: "",
  maxTokens: 2048,
};

function editableLlm(item: LlmConfigItem): WorkflowLlmConfig {
  return {
    id: item.id,
    name: item.name,
    enabled: item.enabled,
    provider: item.provider ?? "openai-compatible",
    model: item.model,
    baseUrl: item.baseUrl,
    chatPath: item.chatPath,
    apiKey: item.apiKey,
    temperature: item.temperature,
    maxTokens: item.maxTokens,
  };
}

type WorkflowMenuIconKind = "more" | "dependencies" | "copy" | "move" | "publish" | "published" | "archive" | "delete";

function WorkflowMenuIcon({ kind }: { kind: WorkflowMenuIconKind }): ReactNode {
  if (kind === "more") return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1.35" /><circle cx="10" cy="10" r="1.35" /><circle cx="16" cy="10" r="1.35" /></svg>;
  if (kind === "dependencies") return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="5" r="2.25" /><circle cx="15" cy="5" r="2.25" /><circle cx="10" cy="15" r="2.25" /><path d="M6.8 6.4 9 12.5M13.2 6.4 11 12.5M7.3 5h5.4" /></svg>;
  if (kind === "copy") return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6.5" y="6.5" width="9" height="9" rx="1.6" /><path d="M13.5 6.5V5.2A1.7 1.7 0 0 0 11.8 3.5H5.2a1.7 1.7 0 0 0-1.7 1.7v6.6a1.7 1.7 0 0 0 1.7 1.7h1.3" /></svg>;
  if (kind === "move") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 6.2V5A1.5 1.5 0 0 1 5 3.5h3l1.6 1.8H15A1.5 1.5 0 0 1 16.5 6.8v7.7A1.5 1.5 0 0 1 15 16H5a1.5 1.5 0 0 1-1.5-1.5v-2.2M2.8 9.2h9.4m-2.7-2.7 2.7 2.7-2.7 2.7" /></svg>;
  if (kind === "publish") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 13.8V3.7M6.4 7.2 10 3.6l3.6 3.6M4 12.4v2.2A1.9 1.9 0 0 0 5.9 16.5h8.2a1.9 1.9 0 0 0 1.9-1.9v-2.2" /></svg>;
  if (kind === "published") return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.5" /><path d="m7 10.1 2 2 4.2-4.3" /></svg>;
  if (kind === "archive") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6.5h12v8.1a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 14.6V6.5ZM3.2 3.6h13.6v2.9H3.2zM8 10h4" /></svg>;
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.7 6.1h10.6M8 3.8h4M6.2 6.1l.7 9a1.5 1.5 0 0 0 1.5 1.3h3.2a1.5 1.5 0 0 0 1.5-1.3l.7-9M8.4 9v4.5M11.6 9v4.5" /></svg>;
}

export function WorkbenchHome({
  currentUser,
  onLogout,
  onOpenWorkflow,
  onCreateWorkflow,
  selectedWorkspaceId,
  onWorkspaceChange,
  workflowListView,
  onWorkflowListViewChange,
  onRunActivityChange,
}: {
  currentUser: AuthUser;
  onLogout: () => void;
  onOpenWorkflow: (id: string) => void;
  onCreateWorkflow: () => void;
  selectedWorkspaceId: string;
  onWorkspaceChange: (id: string) => void;
  workflowListView: WorkflowListViewState;
  onWorkflowListViewChange: Dispatch<SetStateAction<WorkflowListViewState>>;
  onRunActivityChange?: (activity: { readonly runId: string; readonly workflowName: string; readonly state?: DryRunState } | undefined) => void;
}): ReactNode {
  const [active, setActive] = useState<Module>("workflows");
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [workspaceDialogMode, setWorkspaceDialogMode] = useState<'create' | 'edit'>('create');
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspaceDescription, setNewWorkspaceDescription] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [workflowTotal, setWorkflowTotal] = useState(0);
  const { page: workflowPage, query } = workflowListView;
  const workflowRequestId = useRef(0);
  const searchTimer = useRef<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [llms, setLlms] = useState<LlmConfigItem[]>([]);
  const [selectedLlmId, setSelectedLlmId] = useState<string>();
  const [draft, setDraft] = useState<WorkflowLlmConfig>(EMPTY_LLM);
  const [keyDraft, setKeyDraft] = useState("");
  const [savingLlm, setSavingLlm] = useState(false);
  const [testingLlm, setTestingLlm] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<{
    fingerprint: string;
    tone: "success" | "error";
    message: string;
  }>();
  const [publishingWorkflowId, setPublishingWorkflowId] = useState<string>();
  const [copyingWorkflowId, setCopyingWorkflowId] = useState<string>();
  const [moveCandidate, setMoveCandidate] = useState<WorkflowListItem>();
  const [moveTargetWorkspaceId, setMoveTargetWorkspaceId] = useState("");
  const [movingWorkflowId, setMovingWorkflowId] = useState<string>();
  const [deletingWorkflowId, setDeletingWorkflowId] = useState<string>();
  const [deleteCandidate, setDeleteCandidate] = useState<WorkflowListItem>();
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [actionMenuWorkflowId, setActionMenuWorkflowId] = useState<string>();
  const [dependencyFlow, setDependencyFlow] = useState<WorkflowListItem>();
  const [dependencies, setDependencies] = useState<WorkflowDependencies>();
  const [dependencyLoading, setDependencyLoading] = useState(false);
  const [dependencyRevisions, setDependencyRevisions] = useState<readonly WorkflowRevisionItem[]>([]);
  const [dependencyTargetVersion, setDependencyTargetVersion] = useState<number>();
  const [dependencyBulkBusy, setDependencyBulkBusy] = useState(false);
  const [dependencyBulkProgress, setDependencyBulkProgress] = useState("");
  const [dependencyBulkPreview, setDependencyBulkPreview] = useState<DependencyBulkPreview>();
  const [dependencySelectedParents, setDependencySelectedParents] = useState<readonly string[]>([]);
  const [dependencyBulkResult, setDependencyBulkResult] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"success" | "error">("success");
  const [selectedExportIds, setSelectedExportIds] = useState<readonly string[]>([]);
  const [packageBusy, setPackageBusy] = useState(false);
  const [importBundle, setImportBundle] = useState<WorkflowPackage>();
  const [importFileName, setImportFileName] = useState("");
  const [importPreview, setImportPreview] = useState<WorkflowPackagePreview>();
  const importFileRef = useRef<HTMLInputElement>(null);
  const [approvalTotal, setApprovalTotal] = useState(0);
  const pageSize = 12;
  const selectedLlm = llms.find((item) => item.id === selectedLlmId);
  const llmTestFingerprint = JSON.stringify([draft, keyDraft]);
  const llmHasUnsavedChanges =
    selectedLlm !== undefined &&
    (keyDraft !== "" ||
      JSON.stringify(draft) !== JSON.stringify(editableLlm(selectedLlm)));

  useEffect(() => { setSelectedExportIds([]); }, [selectedWorkspaceId]);

  useEffect(() => {
    if (actionMenuWorkflowId === undefined) return;
    const closeOutside = (event: PointerEvent): void => {
      if (!(event.target instanceof Element) || event.target.closest(".workbench-flow-actions") === null) setActionMenuWorkflowId(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setActionMenuWorkflowId(undefined);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [actionMenuWorkflowId]);
  const showNotice = (
    message: string,
    tone: "success" | "error" = "success",
  ): void => {
    setNotice(message);
    setNoticeTone(tone);
  };

  const loadWorkflows = async (
    page = workflowPage,
    search = query,
  ): Promise<void> => {
    const requestId = ++workflowRequestId.current;
    onWorkflowListViewChange((current) => current.page === page ? current : { ...current, page });
    setLoading(true);
    try {
      const result = await listWorkflows(
        RPA_SERVICE_URL,
        page,
        pageSize,
        search,
        selectedWorkspaceId,
      );
      if (requestId !== workflowRequestId.current) return;
      setWorkflows(result.items);
      setWorkflowTotal(result.total);
      onWorkflowListViewChange((current) => ({ ...current, page: result.page }));
      showNotice("");
    } catch (error) {
      if (requestId !== workflowRequestId.current) return;
      showNotice(
        error instanceof Error ? error.message : "读取流程失败",
        "error",
      );
    } finally {
      if (requestId === workflowRequestId.current) setLoading(false);
    }
  };

  const exportSelected = async (): Promise<void> => {
    if (packageBusy || selectedExportIds.length === 0) return;
    if (!window.confirm(`导出的流程包可能包含 API 密钥、Webhook 地址等敏感配置。确认导出 ${selectedExportIds.length} 个流程并妥善保管文件吗？`)) return;
    setPackageBusy(true);
    try {
      const bundle = await exportWorkflowPackage(RPA_SERVICE_URL, selectedExportIds);
      const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `rpa-workflows-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      showNotice(`已导出 ${bundle.roots.length} 个选中流程，包含 ${bundle.workflows.length} 个流程版本及子流程。文件可能含密钥，请妥善保管。`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '导出流程失败', 'error');
    } finally {
      setPackageBusy(false);
    }
  };

  const readImportFile = async (file?: File): Promise<void> => {
    if (!file) return;
    setPackageBusy(true);
    try {
      if (file.size > 18 * 1024 * 1024) throw new Error('流程包超过 18 MB，请拆分导出');
      const bundle = JSON.parse(await file.text()) as WorkflowPackage;
      const preview = await previewWorkflowPackage(RPA_SERVICE_URL, bundle, selectedWorkspaceId);
      setImportFileName(file.name);
      setImportBundle(bundle);
      setImportPreview(preview);
      showNotice('流程包校验通过，请确认导入内容');
    } catch (error) {
      setImportBundle(undefined);
      setImportPreview(undefined);
      showNotice(error instanceof Error ? error.message : '读取流程包失败', 'error');
    } finally {
      if (importFileRef.current) importFileRef.current.value = '';
      setPackageBusy(false);
    }
  };

  const commitImport = async (): Promise<void> => {
    if (!importBundle || !importPreview || packageBusy) return;
    setPackageBusy(true);
    try {
      const result = await importWorkflowPackage(RPA_SERVICE_URL, importBundle, selectedWorkspaceId);
      setImportBundle(undefined);
      setImportPreview(undefined);
      setSelectedExportIds([]);
      await loadWorkflows(1, query);
      showNotice(`成功导入并发布 ${result.items.length} 个新流程（v1），其中 ${result.roots.length} 个为选中主流程。`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '导入流程失败', 'error');
    } finally {
      setPackageBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    void listWorkspaces(RPA_SERVICE_URL).then(result => {
      if (!active) return;
      setWorkspaces(result.items);
      if (!result.items.some(item => item.id === selectedWorkspaceId)) onWorkspaceChange('default');
    }).catch(error => { if (active) showNotice(error instanceof Error ? error.message : '读取空间失败', 'error'); });
    return () => { active = false; };
  }, []);

  const saveWorkspace = async (): Promise<void> => {
    const name = newWorkspaceName.trim();
    if (!name || creatingWorkspace) return;
    setCreatingWorkspace(true);
    try {
      const saved = workspaceDialogMode === 'create'
        ? await createWorkspace(RPA_SERVICE_URL, { name, description: newWorkspaceDescription.trim() })
        : await updateWorkspace(RPA_SERVICE_URL, selectedWorkspaceId, { name, description: newWorkspaceDescription.trim() });
      setWorkspaces(current => workspaceDialogMode === 'create' ? [...current, saved] : current.map(item => item.id === saved.id ? saved : item));
      setNewWorkspaceOpen(false);
      setNewWorkspaceName('');
      setNewWorkspaceDescription('');
      if (workspaceDialogMode === 'create') onWorkspaceChange(saved.id);
      showNotice(`空间「${saved.name}」已${workspaceDialogMode === 'create' ? '创建' : '更新'}`);
    } catch (error) { showNotice(error instanceof Error ? error.message : '保存空间失败', 'error'); }
    finally { setCreatingWorkspace(false); }
  };

  const removeWorkspace = async (): Promise<void> => {
    const current = workspaces.find(item => item.id === selectedWorkspaceId);
    if (!current || current.id === 'default' || !window.confirm(`确定删除空空间「${current.name}」吗？空间内有流程、AI 配置或历史执行/审批记录时服务端会拒绝删除。`)) return;
    setCreatingWorkspace(true);
    try {
      await deleteWorkspace(RPA_SERVICE_URL, current.id);
      setWorkspaces(items => items.filter(item => item.id !== current.id));
      setNewWorkspaceOpen(false);
      onWorkspaceChange('default');
      showNotice(`已删除空间「${current.name}」`);
    } catch (error) { showNotice(error instanceof Error ? error.message : '删除空间失败', 'error'); }
    finally { setCreatingWorkspace(false); }
  };

  const loadLlms = async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await listLlmConfigs(RPA_SERVICE_URL);
      setLlms(result.items);
      const selected =
        result.items.find((item) => item.id === selectedLlmId) ??
        result.items[0];
      setSelectedLlmId(selected?.id);
      setDraft(selected === undefined ? EMPTY_LLM : editableLlm(selected));
      setKeyDraft("");
      showNotice("");
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "读取 AI 配置失败",
        "error",
      );
    } finally {
      setLoading(false);
    }
  };

  const archiveFlow = async (item: WorkflowListItem): Promise<void> => {
    if (!window.confirm(`确定归档流程「${item.name}」吗？`)) return;
    try {
      await archiveWorkflow(RPA_SERVICE_URL, item.id);
      setWorkflows((current) =>
        current.filter((workflow) => workflow.id !== item.id),
      );
      setWorkflowTotal((current) => Math.max(0, current - 1));
      showNotice(`已归档「${item.name}」`);
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "归档流程失败",
        "error",
      );
    }
  };

  const deleteFlowPermanently = async (): Promise<void> => {
    const item = deleteCandidate;
    if (item === undefined || deleteConfirmation !== item.name) return;
    setDeletingWorkflowId(item.id);
    try {
      await deleteWorkflowPermanently(RPA_SERVICE_URL, item.id);
      setWorkflows((current) => current.filter((workflow) => workflow.id !== item.id));
      setWorkflowTotal((current) => Math.max(0, current - 1));
      setDeleteCandidate(undefined);
      setDeleteConfirmation("");
      showNotice(`已永久删除「${item.name}」`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "永久删除流程失败", "error");
    } finally {
      setDeletingWorkflowId(undefined);
    }
  };

  const publishFlow = async (item: WorkflowListItem): Promise<void> => {
    setPublishingWorkflowId(item.id);
    try {
      const { graph } = await getWorkflow(RPA_SERVICE_URL, item.id);
      const subflows = await loadSubflowBundle(RPA_SERVICE_URL, graph);
      const issue = firstPublishIssue(graph, subflows);
      if (issue !== undefined) throw new Error(`发布失败：${issue.message}`);
      const published = await publishWorkflow(RPA_SERVICE_URL, item.id);
      await loadWorkflows(workflowPage, query);
      showNotice(
        `「${item.name}」已发布 v${published.publishedVersion}，现在可以在调用子流程节点中选择它。`,
      );
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "发布流程失败",
        "error",
      );
    } finally {
      setPublishingWorkflowId(undefined);
    }
  };

  const copyFlow = async (item: WorkflowListItem): Promise<void> => {
    setCopyingWorkflowId(item.id);
    try {
      const copied = await copyWorkflow(RPA_SERVICE_URL, item.id);
      onWorkflowListViewChange({ page: 1, query: "" });
      await loadWorkflows(1, "");
      showNotice(
        `已复制「${item.name}」为「${copied.name}」，副本已保存为草稿。`,
      );
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "复制流程失败",
        "error",
      );
    } finally {
      setCopyingWorkflowId(undefined);
    }
  };

  const moveFlow = async (): Promise<void> => {
    const item = moveCandidate;
    const target = workspaces.find(space => space.id === moveTargetWorkspaceId);
    if (!item || !target || target.id === item.workspaceId || movingWorkflowId) return;
    setMovingWorkflowId(item.id);
    try {
      await moveWorkflow(RPA_SERVICE_URL, item.id, target.id);
      setMoveCandidate(undefined);
      await loadWorkflows(workflowPage > 1 && workflows.length === 1 ? workflowPage - 1 : workflowPage, query);
      showNotice(`已将「${item.name}」移动到「${target.name}」。`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "移动流程失败", "error");
    } finally {
      setMovingWorkflowId(undefined);
    }
  };

  const openDependencies = async (item: WorkflowListItem): Promise<void> => {
    setDependencyFlow(item);
    setDependencies(undefined);
    setDependencyRevisions([]);
    setDependencyTargetVersion(item.publishedVersion ?? undefined);
    setDependencyBulkPreview(undefined);
    setDependencySelectedParents([]);
    setDependencyBulkResult("");
    setDependencyBulkProgress("");
    setDependencyLoading(true);
    try {
      const [relations, revisions] = await Promise.all([
        getWorkflowDependencies(RPA_SERVICE_URL, item.id),
        listWorkflowRevisions(RPA_SERVICE_URL, item.id),
      ]);
      setDependencies(relations);
      setDependencyRevisions([...revisions.items].sort((a, b) => b.version - a.version));
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "读取流程依赖失败", "error");
      setDependencyFlow(undefined);
    } finally {
      setDependencyLoading(false);
    }
  };

  const previewDependencyBulkUpdate = async (): Promise<void> => {
    const child = dependencyFlow;
    const version = dependencyTargetVersion;
    if (child === undefined || version === undefined) return;
    setDependencyBulkBusy(true);
    setDependencyBulkProgress("正在读取父流程草稿和子流程版本…");
    setDependencyBulkPreview(undefined);
    setDependencyBulkResult("");
    try {
      const relations = await getWorkflowDependencies(RPA_SERVICE_URL, child.id);
      setDependencies(relations);
      const parentIds = [...new Set(relations.parents.map(item => item.workflow.id))];
      const [targetRevision, parentDrafts] = await Promise.all([
        getWorkflowRevision(RPA_SERVICE_URL, child.id, version),
        Promise.all(parentIds.map(id => getWorkflow(RPA_SERVICE_URL, id))),
      ]);
      if (targetRevision.stage !== "published" || targetRevision.graph.version !== version) throw new Error(`子流程 v${version} 不是可用的已发布版本`);
      const parents = await Promise.all(parentDrafts.map(async parent => ({
        ...parent,
        publishedGraph: parent.publishedVersion === null
          ? null
          : (await getWorkflowRevision(RPA_SERVICE_URL, parent.id, parent.publishedVersion)).graph,
      })));
      const previousVersions = [...new Set(parents.flatMap(parent => parent.graph.nodes.flatMap(node =>
        node.config.type === "call-subflow" && node.config.workflowId === child.id && node.config.workflowVersion !== undefined && node.config.workflowVersion !== version
          ? [node.config.workflowVersion] : []
      )))];
      const previousRevisions = await Promise.all(previousVersions.map(async previousVersion => {
        const revision = await getWorkflowRevision(RPA_SERVICE_URL, child.id, previousVersion);
        if (revision.stage !== "published") throw new Error(`子流程 v${previousVersion} 不是已发布版本`);
        return revision.graph;
      }));
      const plans = planParentVersionUpdates(parents, child.id, targetRevision.graph, previousRevisions);
      setDependencyBulkProgress(`正在校验 ${plans.length} 个父流程的发布条件…`);
      const rows = await Promise.all(plans.map(async plan => {
        const parent = parents.find(item => item.id === plan.parent.id);
        let publishIssue: string | undefined;
        if (parent?.status === "archived") publishIssue = "父流程已归档";
        else if (plan.mode === "update-and-publish" && hasRedactedSecrets(plan.parent.graph)) publishIssue = "父流程包含服务端遮蔽的密钥，无法安全地批量保存";
        else if (plan.plan.nodesMissingRequired > 0) publishIssue = `缺少必填输入：${plan.plan.missingRequiredNames.join("、")}`;
        else {
          try {
            const nextGraph = applyParentVersionUpdate(plan);
            const subflows = await loadSubflowBundle(RPA_SERVICE_URL, nextGraph);
            publishIssue = firstPublishIssue(nextGraph, subflows)?.message;
          } catch (error) {
            publishIssue = error instanceof Error ? error.message : "无法校验父流程";
          }
        }
        return { ...plan, parentStatus: parent?.status ?? "draft", publishIssue };
      }));
      setDependencyBulkPreview({ version, rows });
      setDependencySelectedParents(rows.filter(row => row.publishIssue === undefined).map(row => row.parent.id));
      if (rows.length === 0) setDependencyBulkResult(`所有父流程的调用节点已使用 v${version}，无需更新。`);
    } catch (error) {
      setDependencyBulkResult(error instanceof Error ? error.message : "准备批量更新失败");
    } finally {
      setDependencyBulkBusy(false);
      setDependencyBulkProgress("");
    }
  };

  const applyDependencyBulkUpdate = async (): Promise<void> => {
    const child = dependencyFlow;
    const preview = dependencyBulkPreview;
    if (child === undefined || preview === undefined) return;
    const selected = preview.rows.filter(row => row.publishIssue === undefined && dependencySelectedParents.includes(row.parent.id));
    if (selected.length === 0) return;
    const calls = selected.reduce((total, row) => total + row.plan.updates.size, 0);
    const publishOnly = selected.filter(row => row.mode === "publish-only").length;
    const removed = selected.reduce((total, row) => total + row.plan.removedMappings, 0);
    const warning = removed > 0 ? `\n将移除 ${removed} 项与目标版本不兼容的输入映射。` : "";
    if (!window.confirm(`确认处理 ${selected.length} 个直接父流程：更新 ${calls} 个调用节点${publishOnly > 0 ? `，另有 ${publishOnly} 个父流程草稿已是目标版本、仅需重新发布` : ""}。\n目标子流程：「${child.name}」v${preview.version}。\n发布后会继续向上递归更新祖先流程，直到整条调用链都引用新版本。\n父流程当前草稿中的其他未发布修改也会一并发布。${warning}\n\n若执行过程中某个流程失败，已成功发布的版本不会自动回滚。`)) return;
    setDependencyBulkBusy(true);
    setDependencyBulkResult("");
    const baseApi = {
      getParent: (id: string) => getWorkflow(RPA_SERVICE_URL, id),
      saveDraft: (graph: import("@graph/types.ts").WorkflowGraph) => updateWorkflow(RPA_SERVICE_URL, graph),
      publish: (id: string) => publishWorkflow(RPA_SERVICE_URL, id),
    };
    const outcomes = await executeParentVersionUpdates(selected, baseApi, (index, total, name) => { setDependencyBulkProgress(`正在更新并发布直接父流程 ${index}/${total}：${name}`); });
    const seeds = await Promise.all(outcomes.flatMap((outcome, index) => outcome.status === "published" && outcome.version !== undefined
      ? [{ workflowId: selected[index].parent.id, version: outcome.version }]
      : []).map(async seed => ({ ...seed, graph: (await getWorkflowRevision(RPA_SERVICE_URL, seed.workflowId, seed.version)).graph })));
    const cascaded = await executeCascadingParentVersionUpdates(seeds, {
      ...baseApi,
      listParentIds: async childWorkflowId => [...new Set((await getWorkflowDependencies(RPA_SERVICE_URL, childWorkflowId)).parents.map(item => item.workflow.id))],
      getRevision: async (id, version) => (await getWorkflowRevision(RPA_SERVICE_URL, id, version)).graph,
      validate: async graph => {
        try {
          const subflows = await loadSubflowBundle(RPA_SERVICE_URL, graph);
          return firstPublishIssue(graph, subflows)?.message;
        } catch (error) {
          return error instanceof Error ? error.message : "无法校验级联父流程";
        }
      },
    }, message => { setDependencyBulkProgress(message); });
    const allOutcomes = [...outcomes, ...cascaded];
    const published = allOutcomes.filter(item => item.status === "published").length;
    setDependencyBulkPreview(undefined);
    setDependencySelectedParents([]);
    setDependencyBulkResult(`已发布 ${published}/${allOutcomes.length} 个直接或祖先流程。${allOutcomes.map(item => item.status === "published"
      ? `${item.name}：已发布 v${item.version}`
      : item.status === "draft-only"
        ? `${item.name}：草稿已更新，但发布失败（${item.error}）`
        : `${item.name}：未更新（${item.error}）`).join("；")}`);
    setDependencyBulkBusy(false);
    setDependencyBulkProgress("");
    try {
      setDependencies(await getWorkflowDependencies(RPA_SERVICE_URL, child.id));
      await loadWorkflows(workflowPage, query);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "批量更新后刷新列表失败", "error");
    }
  };

  useEffect(() => {
    if (active === "ai") void loadLlms();
    if (active === "workflows") void loadWorkflows(workflowPage, query);
    else {
      workflowRequestId.current += 1;
      if (searchTimer.current !== undefined) window.clearTimeout(searchTimer.current);
      searchTimer.current = undefined;
    }
  }, [active, selectedWorkspaceId]);
  useEffect(() => {
    return () => {
      workflowRequestId.current += 1;
      if (searchTimer.current !== undefined) window.clearTimeout(searchTimer.current);
    };
  }, []);

  const selectLlm = (item: LlmConfigItem): void => {
    setSelectedLlmId(item.id);
    setDraft(editableLlm(item));
    setKeyDraft("");
  };

  const createNewLlm = (): void => {
    const id = `llm-${Date.now()}`;
    setSelectedLlmId(undefined);
    setDraft({ ...EMPTY_LLM, id, name: `AI 配置 ${llms.length + 1}` });
    setKeyDraft("");
  };

  const saveLlm = async (): Promise<void> => {
    if (!draft.name.trim()) {
      showNotice("请填写配置名称", "error");
      return;
    }
    setSavingLlm(true);
    try {
      const payload = {
        ...draft,
        apiKey: keyDraft || (draft.apiKey === "******" ? "******" : ""),
      };
      const saved = selectedLlm
        ? await updateLlmConfig(RPA_SERVICE_URL, payload)
        : await createLlmConfig(RPA_SERVICE_URL, payload);
      setLlms((current) =>
        selectedLlm
          ? current.map((item) => (item.id === saved.id ? saved : item))
          : [saved, ...current],
      );
      setSelectedLlmId(saved.id);
      selectLlm(saved);
      showNotice("AI 配置已保存到服务端");
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "保存 AI 配置失败",
        "error",
      );
    } finally {
      setSavingLlm(false);
    }
  };

  const testLlm = async (): Promise<void> => {
    if (!selectedLlm || llmHasUnsavedChanges) return;
    const fingerprint = llmTestFingerprint;
    setTestingLlm(true);
    setLlmTestResult(undefined);
    try {
      const result = await testLlmConfig(RPA_SERVICE_URL, selectedLlm.id);
      setLlmTestResult({
        fingerprint,
        tone: "success",
        message: result.message,
      });
    } catch (error) {
      setLlmTestResult({
        fingerprint,
        tone: "error",
        message: error instanceof Error ? error.message : "AI 连接测试失败",
      });
    } finally {
      setTestingLlm(false);
    }
  };

  const removeLlm = async (): Promise<void> => {
    if (
      !selectedLlm ||
      !window.confirm(`确定删除 AI 配置「${selectedLlm.name}」吗？`)
    )
      return;
    try {
      await deleteLlmConfig(RPA_SERVICE_URL, selectedLlm.id);
      const next = llms.filter((item) => item.id !== selectedLlm.id);
      setLlms(next);
      setSelectedLlmId(next[0]?.id);
      if (next[0]) selectLlm(next[0]);
      else setDraft(EMPTY_LLM);
      showNotice("AI 配置已删除");
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "删除 AI 配置失败",
        "error",
      );
    }
  };

  return (
    <div className="workbench-home">
      <aside className="workbench-sidebar">
        <div className="workbench-brand">
          <span>R</span>
          <div>
            <strong>RPA 工作台</strong>
            <small>自动化与数据管理</small>
          </div>
        </div>
        <div className="workbench-space-switcher">
          <label>
            当前空间
            <select aria-label="切换空间" value={selectedWorkspaceId} onChange={event => { onWorkspaceChange(event.target.value); }}>
              {workspaces.length === 0 ? <option value={selectedWorkspaceId}>{selectedWorkspaceId === 'default' ? '默认空间' : '加载中…'}</option> : workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <div className="workbench-space-buttons">
            <button type="button" className="workbench-space-create" onClick={() => { setWorkspaceDialogMode('create'); setNewWorkspaceName(''); setNewWorkspaceDescription(''); setNewWorkspaceOpen(true); }}><span aria-hidden="true">＋</span>新建空间</button>
            <button type="button" className="workbench-space-settings" disabled={workspaces.length === 0} onClick={() => { const current = workspaces.find(item => item.id === selectedWorkspaceId); if (!current) return; setWorkspaceDialogMode('edit'); setNewWorkspaceName(current.name); setNewWorkspaceDescription(current.description); setNewWorkspaceOpen(true); }}>设置</button>
          </div>
        </div>
        <nav aria-label="工作台模块">
          <button
            className={active === "workflows" ? "active" : ""}
            onClick={() => {
              setActive("workflows");
            }}
          >
            <i>◇</i>流程管理
          </button>
          <button
            className={active === "executions" ? "active" : ""}
            onClick={() => {
              setActive("executions");
            }}
          >
            <i>▶</i>执行中心
          </button>
          <button
            className={active === "approvals" ? "active" : ""}
            onClick={() => {
              setActive("approvals");
            }}
          >
            <i>✓</i>审批列表
            {approvalTotal > 0 ? (
              <span className="workbench-nav-count">{approvalTotal}</span>
            ) : null}
          </button>
          <button
            className={active === "ai" ? "active" : ""}
            onClick={() => {
              setActive("ai");
            }}
          >
            <i>✦</i>AI 配置
          </button>
        </nav>
        <div className="workbench-sidebar-footer">
          <span className="service-dot" />
          <span title={`PMS 账号 ${currentUser.username}`}>{currentUser.name}</span>
          <button type="button" onClick={onLogout}>退出</button>
        </div>
      </aside>
      <main className="workbench-main">
        {newWorkspaceOpen ? (
          <div className="context-overlay workbench-space-overlay" role="presentation" onClick={() => { setNewWorkspaceOpen(false); }}>
            <section className="context-panel workbench-space-dialog" role="dialog" aria-modal="true" aria-label={workspaceDialogMode === 'create' ? '新建空间' : '空间设置'} onClick={event => { event.stopPropagation(); }}>
              <div className="context-panel-header">
                <div>
                  <h2>{workspaceDialogMode === 'create' ? '新建空间' : '空间设置'}</h2>
                  <p>{workspaceDialogMode === 'create' ? '为团队流程创建一个清晰的归属。' : '调整当前空间的名称和说明。'}</p>
                </div>
                <button type="button" aria-label="关闭" onClick={() => { setNewWorkspaceOpen(false); }}>×</button>
              </div>
              <label>空间名称<input autoFocus maxLength={80} value={newWorkspaceName} onChange={event => { setNewWorkspaceName(event.target.value); }} placeholder="例如：客服空间" /></label>
              <label>说明（可选）<textarea maxLength={500} value={newWorkspaceDescription} onChange={event => { setNewWorkspaceDescription(event.target.value); }} placeholder="这个空间主要管理哪些流程" /></label>
              <div className="workbench-space-dialog-actions">
                {workspaceDialogMode === 'edit' && selectedWorkspaceId !== 'default' ? <button type="button" className="is-danger" disabled={creatingWorkspace} onClick={() => { void removeWorkspace(); }}>删除空空间</button> : null}
                <button type="button" className="workbench-space-cancel" onClick={() => { setNewWorkspaceOpen(false); }}>取消</button>
                <button type="button" className="workbench-primary" disabled={!newWorkspaceName.trim() || creatingWorkspace} onClick={() => { void saveWorkspace(); }}>{creatingWorkspace ? '保存中…' : workspaceDialogMode === 'create' ? '创建空间' : '保存设置'}</button>
              </div>
            </section>
          </div>
        ) : null}
        {moveCandidate ? (
          <div className="context-overlay workbench-space-overlay" role="presentation" onClick={() => { if (!movingWorkflowId) setMoveCandidate(undefined); }}>
            <section className="context-panel workbench-space-dialog" role="dialog" aria-modal="true" aria-label="移动流程" onClick={event => { event.stopPropagation(); }}>
              <div className="context-panel-header">
                <div>
                  <h2>移动流程</h2>
                  <p>将「{moveCandidate.name}」从「{workspaces.find(space => space.id === moveCandidate.workspaceId)?.name ?? moveCandidate.workspaceId}」移到其他空间。</p>
                </div>
                <button type="button" aria-label="关闭" disabled={movingWorkflowId !== undefined} onClick={() => { setMoveCandidate(undefined); }}>×</button>
              </div>
              <label>
                目标空间
                <select autoFocus value={moveTargetWorkspaceId} onChange={event => { setMoveTargetWorkspaceId(event.target.value); }}>
                  {workspaces.filter(space => space.id !== moveCandidate.workspaceId).map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
                </select>
              </label>
              <p className="workbench-space-move-note">仅改变流程所属空间；流程 ID、已发布版本和子流程引用不变。历史执行与审批记录仍保留在原空间。</p>
              <div className="workbench-space-dialog-actions">
                <button type="button" className="workbench-space-cancel" disabled={movingWorkflowId !== undefined} onClick={() => { setMoveCandidate(undefined); }}>取消</button>
                <button type="button" className="workbench-primary" disabled={movingWorkflowId !== undefined || !moveTargetWorkspaceId || moveTargetWorkspaceId === moveCandidate.workspaceId} onClick={() => { void moveFlow(); }}>{movingWorkflowId ? '移动中…' : '确认移动'}</button>
              </div>
            </section>
          </div>
        ) : null}
        {importPreview && importBundle ? (
          <div className="context-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !packageBusy) { setImportPreview(undefined); setImportBundle(undefined); } }}>
            <section className="context-panel workbench-space-dialog workflow-package-dialog" role="dialog" aria-modal="true" aria-label="导入流程包预览">
              <div className="context-panel-header">
                <div><h2>导入流程包</h2><p>{importFileName} · 目标空间：{workspaces.find(space => space.id === selectedWorkspaceId)?.name ?? selectedWorkspaceId}</p></div>
                <button type="button" aria-label="关闭" disabled={packageBusy} onClick={() => { setImportPreview(undefined); setImportBundle(undefined); }}>×</button>
              </div>
              <p className="workbench-space-move-note">将新增并发布 {importPreview.workflowCount} 个 v1 流程（{importPreview.rootCount} 个选中流程，含其子流程）。原有流程不会被覆盖；流程 ID 与子流程引用会自动重建。请确认目标环境的 URL、AI 配置与密钥。</p>
              <div className="workflow-package-items">
                {importPreview.items.map(item => <div key={`${item.sourceId}@${item.sourceVersion}`}><strong>{item.name}</strong><span>{item.isRoot ? '选中流程' : '依赖子流程'} · 来源 v{item.sourceVersion} · 调用 {item.childCount} 个</span></div>)}
              </div>
              <div className="workbench-space-dialog-actions">
                <button type="button" className="workbench-space-cancel" disabled={packageBusy} onClick={() => { setImportPreview(undefined); setImportBundle(undefined); }}>取消</button>
                <button type="button" className="workbench-primary" disabled={packageBusy} onClick={() => { void commitImport(); }}>{packageBusy ? '导入中…' : '确认导入并发布'}</button>
              </div>
            </section>
          </div>
        ) : null}
        <header className="workbench-topbar">
          <div>
            <span>工作台</span>
            <b>/</b>
            <strong>
              {active === "workflows"
                ? "流程管理"
                : active === "executions"
                  ? "执行中心"
                  : active === "approvals"
                    ? "审批列表"
                    : "AI 配置"}
            </strong>
          </div>
          <span className="workbench-service-status">
            <i aria-hidden="true" />服务端已连接 · 本机执行
          </span>
        </header>
        {notice ? (
          <div className={`workbench-notice is-${noticeTone}`} role="status">
            {notice}
          </div>
        ) : null}
        {active === "workflows" ? (
          <section className="workbench-content">
            <div className="workbench-page-heading">
              <div>
                <span className="eyebrow">AUTOMATIONS</span>
                <h1>流程管理</h1>
                <p>当前空间：{workspaces.find(item => item.id === selectedWorkspaceId)?.name ?? '默认空间'}。新建流程会归属于此空间。</p>
              </div>
              <button className="workbench-primary" onClick={onCreateWorkflow}>
                ＋ 新建流程
              </button>
            </div>
            <div className="workbench-list-toolbar">
              <label className="workbench-search">
                <span>⌕</span>
                <input
                  value={query}
                  onChange={(event) => {
                    const nextQuery = event.target.value;
                    workflowRequestId.current += 1;
                    onWorkflowListViewChange({ page: 1, query: nextQuery });
                    if (searchTimer.current !== undefined) window.clearTimeout(searchTimer.current);
                    searchTimer.current = window.setTimeout(() => {
                      searchTimer.current = undefined;
                      void loadWorkflows(1, nextQuery);
                    }, 250);
                  }}
                  placeholder="搜索流程名称…"
                />
              </label>
              <span>{workflowTotal} 个流程</span>
              <input ref={importFileRef} type="file" accept=".json,application/json" hidden onChange={event => { void readImportFile(event.target.files?.[0]); }} />
              <button type="button" disabled={packageBusy} onClick={() => { importFileRef.current?.click(); }}>导入流程包</button>
              <button type="button" disabled={packageBusy || selectedExportIds.length === 0} onClick={() => { void exportSelected(); }}>导出已选 {selectedExportIds.length > 0 ? `(${selectedExportIds.length})` : ''}</button>
              <button
                onClick={() => {
                  void loadWorkflows(workflowPage, query);
                }}
              >
                刷新
              </button>
            </div>
            {loading ? (
              <div className="workbench-empty">
                <span className="workbench-spinner" />
                正在从服务端读取…
              </div>
            ) : workflows.length === 0 ? (
              <div className="workbench-empty">
                <div className="workbench-empty-icon">◇</div>
                <strong>{query ? "没有匹配的流程" : "还没有流程"}</strong>
                <p>
                  {query
                    ? "换个关键词试试。"
                    : "创建你的第一个流程，开始自动化重复工作。"}
                </p>
                {!query ? (
                  <button
                    className="workbench-primary"
                    onClick={onCreateWorkflow}
                  >
                    ＋ 新建流程
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="workbench-flow-grid">
                {workflows.map((item) => (
                  <article className={`workbench-flow-card${selectedExportIds.includes(item.id) ? ' is-selected-for-export' : ''}`} key={item.id}>
                    <label className="workbench-flow-select" title={item.publishedVersion === null ? '未发布流程不能导出' : '选中导出'}>
                      <input type="checkbox" checked={selectedExportIds.includes(item.id)} disabled={item.publishedVersion === null} onChange={event => { setSelectedExportIds(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id)); }} />
                      <span>导出</span>
                    </label>
                    <button
                      className="workbench-flow-open"
                      onClick={() => {
                        onOpenWorkflow(item.id);
                      }}
                    >
                      <span className="workbench-flow-icon">⌘</span>
                      <strong>{item.name}</strong>
                      <small>
                        {item.status === "published"
                          ? `运行：已发布 v${item.publishedVersion} · 草稿无更新`
                          : item.publishedVersion === null
                            ? "草稿编辑中 · 运行：未发布"
                            : `草稿有更新 · 运行：已发布 v${item.publishedVersion}`}
                      </small>
                      <span className="workbench-flow-relations">
                        {item.kind === "reusable" ? "可复用流程" : "主流程"} · 调用 {item.childCount} 个 · 被 {item.parentCount} 个引用
                      </span>
                      <span className="workbench-flow-relations">编辑：{item.lastEditedByName ?? "历史未记录"} · 发布：{item.lastPublishedByName ?? "尚未记录"}</span>
                      <time>
                        更新于 {new Date(item.updatedAt).toLocaleString()}
                      </time>
                    </button>
                    <div className="workbench-flow-actions">
                      <button
                        className="workbench-flow-more"
                        aria-label={`打开「${item.name}」操作菜单`}
                        aria-expanded={actionMenuWorkflowId === item.id}
                        onClick={() => { setActionMenuWorkflowId((current) => current === item.id ? undefined : item.id); }}
                      >
                        <WorkflowMenuIcon kind="more" />
                      </button>
                      {actionMenuWorkflowId === item.id ? <div className="workbench-flow-menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => { setActionMenuWorkflowId(undefined); void openDependencies(item); }}><WorkflowMenuIcon kind="dependencies" /><span>查看依赖</span></button>
                        <button type="button" role="menuitem" disabled={copyingWorkflowId !== undefined} onClick={() => { setActionMenuWorkflowId(undefined); void copyFlow(item); }}><WorkflowMenuIcon kind="copy" /><span>{copyingWorkflowId === item.id ? "复制中…" : "复制流程"}</span></button>
                        <button type="button" role="menuitem" disabled={workspaces.every(space => space.id === item.workspaceId) || movingWorkflowId !== undefined} onClick={() => { setActionMenuWorkflowId(undefined); setMoveTargetWorkspaceId(workspaces.find(space => space.id !== item.workspaceId)?.id ?? ''); setMoveCandidate(item); }}><WorkflowMenuIcon kind="move" /><span>移动到空间</span></button>
                        {item.status !== "published" ? <button type="button" role="menuitem" disabled={publishingWorkflowId !== undefined} onClick={() => { setActionMenuWorkflowId(undefined); void publishFlow(item); }}><WorkflowMenuIcon kind="publish" /><span>{publishingWorkflowId === item.id ? "发布中…" : item.publishedVersion === null ? "发布流程" : "发布更新"}</span></button> : <button type="button" role="menuitem" disabled><WorkflowMenuIcon kind="published" /><span>已发布 v{item.publishedVersion}</span></button>}
                        <hr />
                        <button type="button" role="menuitem" onClick={() => { setActionMenuWorkflowId(undefined); void archiveFlow(item); }}><WorkflowMenuIcon kind="archive" /><span>归档</span></button>
                        <button type="button" role="menuitem" className="is-danger" disabled={deletingWorkflowId !== undefined} onClick={() => { setActionMenuWorkflowId(undefined); setDeleteConfirmation(""); setDeleteCandidate(item); }}><WorkflowMenuIcon kind="delete" /><span>{deletingWorkflowId === item.id ? "删除中…" : "永久删除"}</span></button>
                      </div> : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
            {workflowTotal > pageSize ? (
              <div className="workbench-pagination">
                <button
                  disabled={workflowPage <= 1 || loading}
                  onClick={() => {
                    void loadWorkflows(workflowPage - 1, query);
                  }}
                >
                  上一页
                </button>
                <span>
                  {workflowPage} / {Math.ceil(workflowTotal / pageSize)}
                </span>
                <button
                  disabled={
                    workflowPage >= Math.ceil(workflowTotal / pageSize) ||
                    loading
                  }
                  onClick={() => {
                    void loadWorkflows(workflowPage + 1, query);
                  }}
                >
                  下一页
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
        {active === "executions" || active === "approvals" ? (
          <ExecutionCenter
            initialTab={active === "approvals" ? "approvals" : "flows"}
            approvalOnly={active === "approvals"}
            workspaceId={selectedWorkspaceId}
            workspaces={workspaces}
            onApprovalTotalChange={setApprovalTotal}
            onApprovalRequested={() => {
              setActive("approvals");
            }}
            onRunActivityChange={onRunActivityChange}
          />
        ) : null}
        {active === "ai" ? (
          <section className="workbench-content">
            <div className="workbench-page-heading">
              <div>
                <span className="eyebrow">MODEL PROVIDERS</span>
                <h1>AI 配置</h1>
                <p>集中管理模型连接；配置保存在 RPA 服务端。</p>
              </div>
              <button className="workbench-primary" onClick={createNewLlm}>
                ＋ 新增配置
              </button>
            </div>
            {loading ? (
              <div className="workbench-empty">正在读取 AI 配置…</div>
            ) : (
              <div className="workbench-ai-layout">
                <div className="workbench-ai-list">
                  <div className="workbench-ai-list-heading">
                    <strong>模型配置</strong>
                    <span>{llms.length}</span>
                  </div>
                  {llms.length === 0 ? (
                    <div className="workbench-ai-empty">
                      暂无配置，点击“新增配置”开始。
                    </div>
                  ) : (
                    llms.map((item) => (
                      <button
                        key={item.id}
                        className={`workbench-ai-item${item.id === selectedLlmId ? " selected" : ""}`}
                        onClick={() => {
                          selectLlm(item);
                        }}
                      >
                        <span className="workbench-ai-symbol">✦</span>
                        <span>
                          <strong>{item.name}</strong>
                          <small>{item.model || "未填写模型"}</small>
                        </span>
                        <i data-enabled={item.enabled} />
                      </button>
                    ))
                  )}
                </div>
                <div className="workbench-ai-editor">
                  <div className="workbench-ai-editor-heading">
                    <div>
                      <strong>{selectedLlm ? "编辑配置" : "新建配置"}</strong>
                      <small>
                        {selectedLlm
                          ? `更新于 ${new Date(selectedLlm.updatedAt).toLocaleString()}`
                          : "保存后可供流程节点引用"}
                      </small>
                    </div>
                    {selectedLlm ? (
                      <button
                        className="workbench-danger-link"
                        onClick={() => {
                          void removeLlm();
                        }}
                      >
                        删除配置
                      </button>
                    ) : null}
                  </div>
                  <div className="workbench-ai-form">
                    <label>
                      配置名称
                      <input
                        value={draft.name}
                        onChange={(event) => {
                          setDraft((current) => ({
                            ...current,
                            name: event.target.value,
                          }));
                        }}
                        placeholder="例如：客服助手"
                      />
                    </label>
                    <label className="workbench-check">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(event) => {
                          setDraft((current) => ({
                            ...current,
                            enabled: event.target.checked,
                          }));
                        }}
                      />
                      启用此配置
                    </label>
                    <label>
                      服务商
                      <select
                        value={draft.provider ?? "openai-compatible"}
                        onChange={(event) => {
                          setDraft((current) => ({
                            ...current,
                            provider: event.target.value,
                          }));
                        }}
                      >
                        <option value="openai-compatible">OpenAI 兼容</option>
                        <option value="openai">OpenAI</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="custom">自定义</option>
                      </select>
                    </label>
                    <label>
                      模型名称
                      <input
                        value={draft.model}
                        onChange={(event) => {
                          setDraft((current) => ({
                            ...current,
                            model: event.target.value,
                          }));
                        }}
                        placeholder="例如 gpt-4o-mini"
                      />
                    </label>
                    <label>
                      API 地址
                      <input
                        value={draft.baseUrl}
                        onChange={(event) => {
                          setDraft((current) => ({
                            ...current,
                            baseUrl: event.target.value,
                          }));
                        }}
                        placeholder="https://api.example.com"
                      />
                    </label>
                    <label>
                      对话接口路径
                      <input
                        value={draft.chatPath}
                        onChange={(event) => {
                          setDraft((current) => ({
                            ...current,
                            chatPath: event.target.value,
                          }));
                        }}
                        placeholder="/v1/chat/completions"
                      />
                    </label>
                    <label>
                      API Key
                      <input
                        type="password"
                        value={keyDraft}
                        onChange={(event) => {
                          setKeyDraft(event.target.value);
                        }}
                        placeholder={
                          draft.apiKey === "******"
                            ? "密钥已保存；留空表示保持不变"
                            : "输入 API Key"
                        }
                      />
                    </label>
                    <div className="workbench-ai-form-row">
                      <label>
                        Temperature
                        <input
                          type="number"
                          min={0}
                          max={2}
                          step={0.1}
                          value={draft.temperature ?? 0.2}
                          onChange={(event) => {
                            setDraft((current) => ({
                              ...current,
                              temperature: Number(event.target.value),
                            }));
                          }}
                        />
                      </label>
                      <label>
                        最大 Token
                        <input
                          type="number"
                          min={1}
                          value={draft.maxTokens}
                          onChange={(event) => {
                            setDraft((current) => ({
                              ...current,
                              maxTokens: Number(event.target.value),
                            }));
                          }}
                        />
                      </label>
                    </div>
                    <div className="workbench-ai-actions">
                      <button
                        disabled={
                          savingLlm ||
                          testingLlm ||
                          !selectedLlm ||
                          llmHasUnsavedChanges
                        }
                        title={
                          !selectedLlm
                            ? "请先保存配置"
                            : llmHasUnsavedChanges
                              ? "请先保存当前修改"
                              : undefined
                        }
                        onClick={() => {
                          void testLlm();
                        }}
                      >
                        {testingLlm ? "测试中…" : "测试联通性"}
                      </button>
                      <button
                        className="workbench-primary"
                        disabled={savingLlm || testingLlm}
                        onClick={() => {
                          void saveLlm();
                        }}
                      >
                        {savingLlm ? "保存中…" : "保存到服务端"}
                      </button>
                    </div>
                    {llmTestResult?.fingerprint === llmTestFingerprint ? (
                      <p
                        className={`workbench-ai-test-result is-${llmTestResult.tone}`}
                        role="status"
                      >
                        {llmTestResult.message}
                      </p>
                    ) : null}
                    <p className="workbench-security-note">
                      服务端返回的密钥为脱敏值。更新时留空会保留原密钥；请先保存配置或修改，再测试服务端保存的版本。
                    </p>
                  </div>
                </div>
              </div>
            )}
          </section>
        ) : null}
        {dependencyFlow ? (
          <div className="execution-dialog-backdrop" role="presentation" onClick={() => { if (!dependencyBulkBusy) setDependencyFlow(undefined); }}>
            <section className="execution-dialog workflow-dependency-dialog" role="dialog" aria-modal="true" aria-label="流程依赖关系" onClick={(event) => { event.stopPropagation(); }}>
              <header>
                <div><h2>{dependencyFlow.name}</h2><p>流程调用关系 · 支持主流程与主流程之间调用</p></div>
                <button type="button" aria-label="关闭" disabled={dependencyBulkBusy} onClick={() => { setDependencyFlow(undefined); }}>×</button>
              </header>
              <div className="execution-dialog-body">
                {dependencyLoading ? <p>正在读取依赖关系…</p> : <>
                  <section className="workflow-dependency-section">
                    <strong>调用的流程</strong>
                    {dependencies?.children.length ? dependencies.children.map((item) => <button key={`${item.callNodeId}-${item.workflow.id}`} onClick={() => { setDependencyFlow(undefined); onOpenWorkflow(item.workflow.id); }}><span>{workspaces.find(space => space.id === item.workflow.workspaceId)?.name ?? item.workflow.workspaceId} / {item.workflow.name}</span><small>固定版本 v{item.childVersion} · 节点 {item.callNodeId}</small></button>) : <p>没有调用其他流程</p>}
                  </section>
                  <section className="workflow-dependency-section">
                    <strong>被以下流程引用</strong>
                    {dependencies?.parents.length ? dependencies.parents.map((item) => <button key={`${item.workflow.id}-${item.callNodeId}`} disabled={dependencyBulkBusy} onClick={() => { setDependencyFlow(undefined); onOpenWorkflow(item.workflow.id); }}><span>{workspaces.find(space => space.id === item.workflow.workspaceId)?.name ?? item.workflow.workspaceId} / {item.workflow.name}</span><small>当前固定 v{item.childVersion} · 节点 {item.callNodeId}</small></button>) : <p>尚未被其他流程引用</p>}
                  </section>
                  {dependencies?.parents.length ? <section className="workflow-dependency-bulk">
                    <div><strong>批量更新父流程引用版本</strong><p>先预览输入映射和发布校验；确认后逐个保存父流程草稿并发布新版本。</p></div>
                    <div className="workflow-dependency-bulk-controls">
                      <label>目标子流程版本<select aria-label="批量更新目标子流程版本" value={dependencyTargetVersion ?? ""} disabled={dependencyBulkBusy} onChange={event => { setDependencyTargetVersion(event.target.value ? Number(event.target.value) : undefined); setDependencyBulkPreview(undefined); setDependencyBulkResult(""); }}>
                        {dependencyRevisions.map(revision => <option key={revision.id} value={revision.version}>v{revision.version}{revision.version === dependencyFlow.publishedVersion ? " · 最新发布" : ""}</option>)}
                      </select></label>
                      <button type="button" disabled={dependencyBulkBusy || dependencyTargetVersion === undefined} onClick={() => { void previewDependencyBulkUpdate(); }}>预览影响</button>
                    </div>
                    {dependencyBulkProgress ? <p role="status">{dependencyBulkProgress}</p> : null}
                    {dependencyBulkPreview ? <div className="workflow-dependency-bulk-preview">
                      <strong>预览：{dependencyBulkPreview.rows.length} 个父流程需要更新到 v{dependencyBulkPreview.version}</strong>
                      {dependencyBulkPreview.rows.map(row => <label key={row.parent.id} className="workflow-dependency-parent-option" data-blocked={row.publishIssue !== undefined ? "true" : undefined}>
                        <input type="checkbox" checked={dependencySelectedParents.includes(row.parent.id)} disabled={dependencyBulkBusy || row.publishIssue !== undefined} onChange={event => { setDependencySelectedParents(current => event.target.checked ? [...current, row.parent.id] : current.filter(id => id !== row.parent.id)); }} />
                        <span><strong>{row.parent.name}</strong><small>{row.mode === "publish-only" ? "草稿已引用目标版本，但已发布版本仍旧；将仅重新发布父流程" : `${row.plan.updates.size} 个调用节点将更新`}；{row.parentStatus === "draft" ? "父流程有未发布草稿" : row.parentStatus === "archived" ? "父流程已归档" : "父流程当前已发布"}</small>{row.plan.removedMappings > 0 ? <small>将移除 {row.plan.removedMappings} 项不兼容输入映射</small> : null}{row.publishIssue ? <small className="workflow-dependency-blocker">无法发布：{row.publishIssue}</small> : null}</span>
                      </label>)}
                      {dependencyBulkPreview.rows.length > 0 ? <p>注意：父流程草稿中其他未发布修改也会一并发布；若部分流程更新失败，已发布的版本不会自动回滚。</p> : null}
                      <button type="button" className="workflow-dependency-bulk-submit" disabled={dependencyBulkBusy || dependencySelectedParents.length === 0} onClick={() => { void applyDependencyBulkUpdate(); }}>更新并发布 {dependencySelectedParents.length} 个父流程</button>
                    </div> : null}
                    {dependencyBulkResult ? <p className="workflow-dependency-bulk-result" role="status">{dependencyBulkResult}</p> : null}
                  </section> : null}
                </>}
              </div>
            </section>
          </div>
        ) : null}
        {deleteCandidate ? <div className="execution-dialog-backdrop" role="presentation" onClick={() => { if (deletingWorkflowId === undefined) { setDeleteCandidate(undefined); setDeleteConfirmation(""); } }}>
          <section className="execution-dialog workflow-delete-dialog" role="dialog" aria-modal="true" aria-label="永久删除流程" onClick={(event) => { event.stopPropagation(); }}>
            <header><div><h2>永久删除流程</h2><p>此操作无法撤销，请确认删除范围。</p></div><button type="button" aria-label="关闭" disabled={deletingWorkflowId !== undefined} onClick={() => { setDeleteCandidate(undefined); setDeleteConfirmation(""); }}>×</button></header>
            <div className="execution-dialog-body">
              <div className="workflow-delete-warning"><strong>将永久删除「{deleteCandidate.name}」</strong><p>草稿、全部发布版本、执行记录、事件日志及审批记录都会被清除。如果该流程仍被其他流程引用，服务端将拒绝删除。</p></div>
              <label className="workflow-delete-confirmation"><span>请输入流程名称 <b>{deleteCandidate.name}</b> 以确认</span><input autoFocus value={deleteConfirmation} disabled={deletingWorkflowId !== undefined} onChange={(event) => { setDeleteConfirmation(event.target.value); }} placeholder={deleteCandidate.name} /></label>
            </div>
            <footer><button type="button" disabled={deletingWorkflowId !== undefined} onClick={() => { setDeleteCandidate(undefined); setDeleteConfirmation(""); }}>取消</button><button type="button" className="workflow-delete-confirm" disabled={deleteConfirmation !== deleteCandidate.name || deletingWorkflowId !== undefined} onClick={() => { void deleteFlowPermanently(); }}>{deletingWorkflowId === deleteCandidate.id ? "正在永久删除…" : "确认永久删除"}</button></footer>
          </section>
        </div> : null}
      </main>
    </div>
  );
}

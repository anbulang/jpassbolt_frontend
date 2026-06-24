/**
 * ResourceFormModal — create or edit a password resource.
 *
 * Fields: name / username / uri / description, a resource-type selector, and a
 * destination-folder picker (create mode only). The password lives in a
 * PasswordField with a generate helper.
 *
 * Crypto: on submit the secret plaintext is encrypted for the CURRENT user's
 * OWN public key only (the creator) via useKey().encryptFor([ownPublicKey]),
 * then POSTed (create) / PUT (edit). On edit we prefetch + decrypt the existing
 * secret to prefill, and re-encrypt on save. Plaintext is never logged.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Folder,
  MetadataTypesSettings,
  Resource,
  ResourceCreateRequest,
  ResourceType,
  ResourceUpdateRequest,
} from '../../types';
import { createResource, updateResource } from '../../services/resources';
import { listFolders } from '../../services/folders';
import { getSecretForResource } from '../../services/secrets';
import { getMetadataTypesSettings } from '../../services/metadata';
import { useKey } from '../../crypto/KeyContext';
import { useMetadataKey } from '../../crypto/MetadataKeyContext';
import { useToast } from '../../components/toastContext';
import { Modal } from '../../components/Modal';
import { PasswordField } from '../../components/PasswordField';
import { Spinner } from '../../components/Spinner';
import {
  RESOURCE_TYPE_ID,
  V5_PASSWORD_SLUGS,
  buildResourceMetadataJson,
  decodeSecret,
  encodeSecret,
  isEncryptedDescriptionType,
} from './secretFormat';
import { decideResourceFormat } from './resourceFormat';

interface ResourceFormModalProps {
  open: boolean;
  /** Resource to edit, or null for create mode. */
  resource: Resource | null;
  resourceTypes: ResourceType[];
  folders: Folder[];
  /** Pre-selected destination folder for new resources (create mode). */
  defaultFolderId?: string | null;
  onClose: () => void;
  /** Called after a successful create/update so the caller refetches. */
  onSaved: () => void;
}

interface FormState {
  name: string;
  username: string;
  uri: string;
  description: string;
  password: string;
  resourceTypeId: string;
  folderParentId: string;
}

const EMPTY: FormState = {
  name: '',
  username: '',
  uri: '',
  description: '',
  password: '',
  resourceTypeId: '',
  folderParentId: '',
};

/**
 * Offer the password-shaped resource types the org policy dictates — NEVER a
 * v4-vs-v5 choice. When the org selects v5 (default_resource_types==='v5' AND
 * v5 creation allowed), the selector surfaces the v5 slugs; otherwise the v4
 * slugs. The user only ever sees "Password" / "Password & description"-style
 * names; the v4/v5 distinction is invisible.
 */
function passwordResourceTypes(
  types: ResourceType[],
  typesSettings: MetadataTypesSettings | null
): ResourceType[] {
  const v5Active =
    typesSettings?.default_resource_types === 'v5' &&
    typesSettings.allow_creation_of_v5_resources === true;
  const allowed = new Set<string>(
    v5Active
      ? (V5_PASSWORD_SLUGS as readonly string[])
      : ['password-string', 'password-and-description']
  );
  const filtered = types.filter((t) => allowed.has(t.slug) && !t.deleted);
  if (filtered.length > 0) return filtered;
  const anyMatch = types.filter((t) => allowed.has(t.slug));
  if (anyMatch.length > 0) return anyMatch;
  // Fall back to the v4 slugs if the org selected v5 but no v5 type exists yet
  // (forward-compat: keeps the form usable until v5 types are seeded).
  const v4Allowed = new Set<string>(['password-string', 'password-and-description']);
  const v4 = types.filter((t) => v4Allowed.has(t.slug) && !t.deleted);
  return v4.length > 0 ? v4 : types.filter((t) => v4Allowed.has(t.slug));
}

function errMessage(err: unknown, fallback: string): string {
  const apiMsg = (err as { response?: { data?: { header?: { message?: string } } } })?.response
    ?.data?.header?.message;
  if (apiMsg) return apiMsg;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function ResourceFormModal({
  open,
  resource,
  resourceTypes,
  folders,
  defaultFolderId,
  onClose,
  onSaved,
}: ResourceFormModalProps) {
  const { encryptForSelf, ownPublicKeyArmored, isLocked, decrypt } = useKey();
  const {
    available: metadataKeyAvailable,
    encryptResourceMetadata,
  } = useMetadataKey();
  const toast = useToast();
  const isEdit = !!resource;

  // Org create-format policy. Loaded once per open; null until it arrives. The
  // service always resolves to a well-formed all-v4 default when the row is
  // absent, so a null here only means "still loading" — the v4 path is the safe
  // default in either case.
  const [typesSettings, setTypesSettings] = useState<MetadataTypesSettings | null>(null);

  const typeOptions = useMemo(
    () => passwordResourceTypes(resourceTypes, typesSettings),
    [resourceTypes, typesSettings]
  );

  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [prefilling, setPrefilling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Destination-folder options for the picker. Seeded from the prop (so it is
  // never momentarily empty) then refreshed from the server each time the modal
  // opens — the sidebar FolderTree fetches folders independently, so a folder
  // just created there would otherwise be missing from a stale cached prop.
  const [folderOptions, setFolderOptions] = useState<Folder[]>(folders);

  const currentSlug = useMemo(
    () => resourceTypes.find((t) => t.id === form.resourceTypeId)?.slug,
    [resourceTypes, form.resourceTypeId]
  );
  const usesEncryptedDescription = isEncryptedDescriptionType(currentSlug);

  // -------------------------------------------------------------------------
  // Form (re)initialization.
  //
  // The reset MUST only run on a genuine "open" transition or when the target
  // resource id changes — NOT on every dependency change. Earlier this effect
  // listed resourceTypes/typeOptions/decrypt and reset the form unconditionally,
  // so a parent re-render (new typeOptions reference, resourceTypes arriving)
  // would wipe whatever the user had typed mid-edit. We track the last
  // initialized key (open + resource id) in a ref and only reset when it flips.
  // -------------------------------------------------------------------------
  const initKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      // Closing the modal: forget the key so the next open re-initializes.
      initKeyRef.current = null;
      return;
    }
    const key = isEdit && resource ? `edit:${resource.id}` : 'create';
    if (initKeyRef.current === key) return; // already initialized for this open/resource
    initKeyRef.current = key;

    setError(null);
    if (isEdit && resource) {
      const slug = resourceTypes.find((t) => t.id === resource.resource_type_id)?.slug;
      setForm({
        name: resource.name ?? '',
        username: resource.username ?? '',
        uri: resource.uri ?? '',
        description: isEncryptedDescriptionType(slug) ? '' : resource.description ?? '',
        password: '',
        resourceTypeId: resource.resource_type_id,
        folderParentId: '',
      });
    } else {
      const defaultType =
        typeOptions.find((t) => t.id === RESOURCE_TYPE_ID.PASSWORD_AND_DESCRIPTION) ??
        typeOptions.find((t) => t.id === RESOURCE_TYPE_ID.PASSWORD_STRING) ??
        typeOptions[0];
      setForm({
        ...EMPTY,
        resourceTypeId: defaultType?.id ?? '',
        folderParentId: defaultFolderId ?? '',
      });
    }
  }, [open, isEdit, resource, resourceTypes, typeOptions, defaultFolderId]);

  // -------------------------------------------------------------------------
  // Async prefill (edit mode): prefetch + decrypt the existing secret to fill
  // the password/description fields. Keyed on the resource id (and open/lock
  // state) so it fires once per opened resource — and never clobbers the
  // synchronous reset above mid-edit.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!open || !isEdit || !resource || isLocked) return;
    const slug = resourceTypes.find((t) => t.id === resource.resource_type_id)?.slug;
    let cancelled = false;
    setPrefilling(true);
    (async () => {
      try {
        const secret = await getSecretForResource(resource.id);
        const plaintext = await decrypt(secret.data);
        if (cancelled) return;
        const content = decodeSecret(slug, plaintext);
        setForm((f) => ({
          ...f,
          password: content.password,
          description: isEncryptedDescriptionType(slug) ? content.description : f.description,
        }));
      } catch (err) {
        if (!cancelled) setError(errMessage(err, '无法加载当前密钥以进行编辑。'));
      } finally {
        if (!cancelled) setPrefilling(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // resource.id is the stable identity; resourceTypes is read for the slug but
    // an arriving-types re-render should not re-trigger a network prefill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEdit, resource?.id, isLocked, decrypt]);

  // -------------------------------------------------------------------------
  // Load the org create-format policy when the modal opens. Drives the format
  // decision + the type selector. Failures are tolerated (degrade to v4 via the
  // service's all-v4 default), so a settings outage never blocks creating a v4
  // resource. Kept separate from the form-init effect so an arriving policy
  // never clobbers user input.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const settings = await getMetadataTypesSettings();
        if (!cancelled) setTypesSettings(settings);
      } catch {
        // Tolerate: the v4 path is the safe default when the policy is unknown.
        if (!cancelled) setTypesSettings(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Refresh the create-mode folder picker whenever the modal opens. Re-seed from
  // the prop first (instant, non-empty), then replace with a live /folders.json
  // read so a folder just created in the sidebar is selectable without a full
  // vault reload. Skipped in edit mode — folder change there is a separate "移动
  // 到…" action (Passbolt stores tree placement in folders_relations, not on the
  // resource, and PUT /resources never touches it). Failures keep the prop list.
  useEffect(() => {
    if (!open || isEdit) return;
    setFolderOptions(folders);
    let cancelled = false;
    (async () => {
      try {
        const fresh = await listFolders();
        if (!cancelled) setFolderOptions(fresh);
      } catch {
        // keep the seeded prop list
      }
    })();
    return () => {
      cancelled = true;
    };
    // `folders` is re-seeded synchronously above on each open; listing it as a
    // dep would refetch on every parent refetch, so it is intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEdit]);

  // -------------------------------------------------------------------------
  // Create mode: keep the selected resource type VALID as the org policy loads.
  //
  // The form-init effect above picks a default type from `typeOptions` while
  // `typesSettings` is still null — i.e. the v4 slugs. When the policy then
  // arrives and flips the offered types to v5, the previously-selected v4 type id
  // is no longer in `typeOptions`, but the guarded init effect never re-runs, so
  // the form stayed pinned to a v4 type and decideResourceFormat wrongly chose v4
  // even though the org enabled v5 (race found in real cross-user browser
  // testing). Re-default whenever the current selection falls out of the offered
  // set. Guarded to CREATE mode and only when the selection is invalid, so it
  // never clobbers a deliberate user choice (a still-offered id is left intact).
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!open || isEdit) return;
    setForm((f) => {
      if (f.resourceTypeId && typeOptions.some((t) => t.id === f.resourceTypeId)) {
        return f; // current selection still offered — keep it
      }
      const def =
        typeOptions.find((t) => t.slug === 'v5-default') ??
        typeOptions.find((t) => t.id === RESOURCE_TYPE_ID.PASSWORD_AND_DESCRIPTION) ??
        typeOptions.find((t) => t.id === RESOURCE_TYPE_ID.PASSWORD_STRING) ??
        typeOptions[0];
      return def ? { ...f, resourceTypeId: def.id } : f;
    });
  }, [open, isEdit, typeOptions]);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const canSubmit =
    form.name.trim().length > 0 && form.password.length > 0 && !!form.resourceTypeId && !isLocked;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError(null);

    if (!ownPublicKeyArmored) {
      setError('您的公钥不可用。请解锁保险库后重试。');
      return;
    }

    const selectedType = resourceTypes.find((t) => t.id === form.resourceTypeId);
    if (!selectedType) {
      setError('所选资源类型不可用。请刷新后重试。');
      return;
    }

    // Decide v4 (cleartext columns) vs v5 (encrypted metadata) purely from the
    // org policy + metadata-key availability — never a user toggle. Today's
    // defaults always yield v4; this flips to v5 transparently once an admin
    // enables it AND a metadata key exists.
    const decision = decideResourceFormat({
      typesSettings,
      selectedResourceType: selectedType,
      metadataKeyAvailable,
      allowPersonalKeys: false,
    });

    setSaving(true);
    try {
      // SECRET path is IDENTICAL in both branches: same per-slug encoding,
      // same per-recipient (own-key) GPG encryption.
      const plaintext = encodeSecret(currentSlug, {
        password: form.password,
        description: usesEncryptedDescription ? form.description : '',
      });
      // Encrypt for the OWNER's own public key only (the creator).
      const armoredSecret = await encryptForSelf(plaintext);

      // The user-visible name/username/uri/description. In v4 these are sent as
      // cleartext columns; in v5 they live inside the encrypted metadata blob.
      const name = form.name.trim();
      const username = form.username.trim();
      const uri = form.uri.trim();
      // v5 keeps the full description in the metadata blob; v4's encrypted-desc
      // types keep it in the secret and send '' for the column.
      const cleartextDescription = usesEncryptedDescription ? '' : form.description;

      if (decision.format === 'v5') {
        // Build the v5 metadata cleartext, then encrypt it to the verified
        // shared metadata PUBLIC key (encryptResourceMetadata verifies the
        // active key's fingerprint first — server-substitution defence).
        const metadataJson = buildResourceMetadataJson({
          resource_type_id: form.resourceTypeId,
          name,
          username,
          uri,
          description: form.description,
        });
        const { metadata, metadata_key_id, metadata_key_type } =
          await encryptResourceMetadata(metadataJson);

        if (isEdit && resource) {
          const req: ResourceUpdateRequest = {
            resource_type_id: form.resourceTypeId,
            metadata,
            metadata_key_id,
            metadata_key_type,
            secrets: [{ data: armoredSecret }],
          };
          await updateResource(resource.id, req);
          toast.success('凭据已更新');
        } else {
          // v5 create: the real name/username/uri/description live encrypted in
          // `metadata`. The v4 cleartext columns are OMITTED entirely — PHP's
          // MetadataResourceDto rejects any non-null v4 field on a v5 payload
          // ("V4 related fields are not supported for V5."), so sending '' fails.
          const req: ResourceCreateRequest = {
            resource_type_id: form.resourceTypeId,
            metadata,
            metadata_key_id,
            metadata_key_type,
            ...(form.folderParentId ? { folder_parent_id: form.folderParentId } : {}),
            secrets: [{ data: armoredSecret }],
          };
          await createResource(req);
          toast.success('凭据已创建');
        }
      } else if (isEdit && resource) {
        const req: ResourceUpdateRequest = {
          name,
          username,
          uri,
          description: cleartextDescription,
          resource_type_id: form.resourceTypeId,
          secrets: [{ data: armoredSecret }],
        };
        await updateResource(resource.id, req);
        toast.success('凭据已更新');
      } else {
        const req: ResourceCreateRequest = {
          name,
          username,
          uri,
          description: cleartextDescription,
          resource_type_id: form.resourceTypeId,
          ...(form.folderParentId ? { folder_parent_id: form.folderParentId } : {}),
          secrets: [{ data: armoredSecret }],
        };
        await createResource(req);
        toast.success('凭据已创建');
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(errMessage(err, '保存凭据失败。'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={isEdit ? '编辑凭据' : '新建凭据'}
      onClose={saving ? () => {} : onClose}
      maxWidth={560}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!canSubmit || saving}>
            {saving ? '保存中…' : isEdit ? '保存更改' : '创建'}
          </button>
        </>
      }
    >
      {error && (
        <div
          style={{
            background: 'rgba(248, 81, 73, 0.1)',
            color: 'var(--danger-color)',
            border: '1px solid var(--danger-color)',
            borderRadius: 'var(--radius-sm)',
            padding: '10px 14px',
            marginBottom: '18px',
            fontSize: '13px',
          }}
        >
          {error}
        </div>
      )}

      {prefilling && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            color: 'var(--text-muted)',
            marginBottom: '16px',
            fontSize: '13px',
          }}
        >
          <Spinner size={16} /> 正在解密当前密钥…
        </div>
      )}

      <div className="form-group">
        <label className="form-label">名称 *</label>
        <input
          className="form-control"
          value={form.name}
          onChange={(e) => setField('name', e.target.value)}
          placeholder="例如：GitHub"
          autoFocus
        />
      </div>

      <div className="form-group">
        <label className="form-label">用户名</label>
        <input
          className="form-control"
          value={form.username}
          onChange={(e) => setField('username', e.target.value)}
          placeholder="you@example.com"
        />
      </div>

      <div className="form-group">
        <label className="form-label">网址</label>
        <input
          className="form-control"
          value={form.uri}
          onChange={(e) => setField('uri', e.target.value)}
          placeholder="https://example.com"
        />
      </div>

      <PasswordField
        label="密码 *"
        value={form.password}
        onChange={(v) => setField('password', v)}
        showStrength
        showGenerate
      />

      <div className="form-group">
        <label className="form-label">描述</label>
        <textarea
          className="form-control"
          value={form.description}
          onChange={(e) => setField('description', e.target.value)}
          placeholder={
            usesEncryptedDescription
              ? '随密钥一起加密'
              : '可选备注（不加密存储）'
          }
        />
      </div>

      <div className="form-group">
        <label className="form-label">类型</label>
        <select
          className="form-control"
          value={form.resourceTypeId}
          onChange={(e) => setField('resourceTypeId', e.target.value)}
        >
          {typeOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      {!isEdit && (
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">文件夹</label>
          <select
            className="form-control"
            value={form.folderParentId}
            onChange={(e) => setField('folderParentId', e.target.value)}
          >
            <option value="">无文件夹（根目录）</option>
            {folderOptions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </Modal>
  );
}

export default ResourceFormModal;

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
  Resource,
  ResourceCreateRequest,
  ResourceType,
  ResourceUpdateRequest,
} from '../../types';
import { createResource, updateResource } from '../../services/resources';
import { getSecretForResource } from '../../services/secrets';
import { useKey } from '../../crypto/KeyContext';
import { useToast } from '../../components/toastContext';
import { Modal } from '../../components/Modal';
import { PasswordField } from '../../components/PasswordField';
import { Spinner } from '../../components/Spinner';
import {
  RESOURCE_TYPE_ID,
  decodeSecret,
  encodeSecret,
  isEncryptedDescriptionType,
} from './secretFormat';

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

/** Only password-shaped types are offered (TOTP / v5 are out of scope here). */
function passwordResourceTypes(types: ResourceType[]): ResourceType[] {
  const allowed = new Set<string>(['password-string', 'password-and-description']);
  const filtered = types.filter((t) => allowed.has(t.slug) && !t.deleted);
  return filtered.length > 0 ? filtered : types.filter((t) => allowed.has(t.slug));
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
  const toast = useToast();
  const isEdit = !!resource;

  const typeOptions = useMemo(() => passwordResourceTypes(resourceTypes), [resourceTypes]);

  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [prefilling, setPrefilling] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        if (!cancelled) setError(errMessage(err, 'Could not load the current secret to edit.'));
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

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const canSubmit =
    form.name.trim().length > 0 && form.password.length > 0 && !!form.resourceTypeId && !isLocked;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError(null);

    if (!ownPublicKeyArmored) {
      setError('Your own public key is unavailable. Unlock your vault and try again.');
      return;
    }

    setSaving(true);
    try {
      const plaintext = encodeSecret(currentSlug, {
        password: form.password,
        description: usesEncryptedDescription ? form.description : '',
      });
      // Encrypt for the OWNER's own public key only (the creator).
      const armoredSecret = await encryptForSelf(plaintext);

      if (isEdit && resource) {
        const req: ResourceUpdateRequest = {
          name: form.name.trim(),
          username: form.username.trim(),
          uri: form.uri.trim(),
          description: usesEncryptedDescription ? '' : form.description,
          resource_type_id: form.resourceTypeId,
          secrets: [{ data: armoredSecret }],
        };
        await updateResource(resource.id, req);
        toast.success('Password updated');
      } else {
        const req: ResourceCreateRequest = {
          name: form.name.trim(),
          username: form.username.trim(),
          uri: form.uri.trim(),
          description: usesEncryptedDescription ? '' : form.description,
          resource_type_id: form.resourceTypeId,
          ...(form.folderParentId ? { folder_parent_id: form.folderParentId } : {}),
          secrets: [{ data: armoredSecret }],
        };
        await createResource(req);
        toast.success('Password created');
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(errMessage(err, 'Failed to save the password.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={isEdit ? 'Edit password' : 'New password'}
      onClose={saving ? () => {} : onClose}
      maxWidth={560}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!canSubmit || saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create'}
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
          <Spinner size={16} /> Decrypting current secret…
        </div>
      )}

      <div className="form-group">
        <label className="form-label">Name *</label>
        <input
          className="form-control"
          value={form.name}
          onChange={(e) => setField('name', e.target.value)}
          placeholder="e.g. GitHub"
          autoFocus
        />
      </div>

      <div className="form-group">
        <label className="form-label">Username</label>
        <input
          className="form-control"
          value={form.username}
          onChange={(e) => setField('username', e.target.value)}
          placeholder="you@example.com"
        />
      </div>

      <div className="form-group">
        <label className="form-label">URI</label>
        <input
          className="form-control"
          value={form.uri}
          onChange={(e) => setField('uri', e.target.value)}
          placeholder="https://example.com"
        />
      </div>

      <PasswordField
        label="Password *"
        value={form.password}
        onChange={(v) => setField('password', v)}
        showStrength
        showGenerate
      />

      <div className="form-group">
        <label className="form-label">Description</label>
        <textarea
          className="form-control"
          value={form.description}
          onChange={(e) => setField('description', e.target.value)}
          placeholder={
            usesEncryptedDescription
              ? 'Encrypted with the secret'
              : 'Optional notes (stored unencrypted)'
          }
        />
      </div>

      <div className="form-group">
        <label className="form-label">Type</label>
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
          <label className="form-label">Folder</label>
          <select
            className="form-control"
            value={form.folderParentId}
            onChange={(e) => setField('folderParentId', e.target.value)}
          >
            <option value="">No folder (root)</option>
            {folders.map((f) => (
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

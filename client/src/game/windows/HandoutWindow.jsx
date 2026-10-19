import { useState, useEffect, useRef } from 'preact/hooks';
import { useApp, useStoreEvents } from '../hooks.js';
import { FloatingWindow, Button, Field, Toggle, toast } from '../../ui/components.jsx';
import { formatText, sanitizeChatHtml } from '../chat/format.js';

export function HandoutWindow({ winKey, id }) {
  const app = useApp();
  const { store, net } = app;
  useStoreEvents(store, ['col:handout', 'members'], (ev, h, hid) => ev !== 'col:handout' || hid === id);
  const h = store.col.handout.get(id);
  const gm = store.isGM;
  const canEdit = gm || (h?.controlledBy || []).includes(store.me.id) || (h?.controlledBy || []).includes('all');
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState(h?.name || '');
  const [notes, setNotes] = useState(h?.notes || '');
  const [gmnotes, setGmnotes] = useState(h?.gmnotes || '');
  const fileRef = useRef();
  useEffect(() => {
    if (!edit && h) {
      setName(h.name);
      setNotes(h.notes || '');
      setGmnotes(h.gmnotes || '');
    }
  }, [h, edit]);
  if (!h) return null;
  const upd = (patch) => net.update('handout', id, patch).then((r) => r?.error && toast(r.error, 'error'));
  const save = () => {
    upd({ name, notes, ...(gm ? { gmnotes } : {}) });
    setEdit(false);
  };
  const players = [...store.members.values()].filter((m) => m.role !== 'gm');
  const toggle = (field, uid) => {
    const s = new Set(h[field] || []);
    s.has(uid) ? s.delete(uid) : s.add(uid);
    upd({ [field]: [...s] });
  };
  const uploadImg = async (e) => {
    const f = e.currentTarget.files[0];
    if (!f) return;
    const a = await app.upload([f], 'материалы');
    if (a[0]) upd({ avatar: a[0].url });
  };
  return (
    <FloatingWindow id={'handout:' + id} title={h.name || 'Материал'} onClose={() => app.closeWin(winKey)} width={560} height={620} icon="scroll">
      <div class="handout-body">
        {h.avatar && <img class="handout-img" src={h.avatar} alt="" />}
        {edit ? (
          <>
            <Field label="Название">
              <input class="input" value={name} onInput={(e) => setName(e.currentTarget.value)} />
            </Field>
            <div class="row" style={{ marginBottom: '10px' }}>
              <input type="file" accept="image/*" hidden ref={fileRef} onChange={uploadImg} />
              <Button size="sm" onClick={() => fileRef.current.click()}>
                {h.avatar ? 'Сменить картинку' : 'Добавить картинку'}
              </Button>
              {h.avatar && (
                <Button size="sm" kind="ghost" onClick={() => upd({ avatar: '' })}>
                  Убрать картинку
                </Button>
              )}
            </div>
            <Field label="Текст" hint="**жирный**, *курсив*, [ссылка](https://…), картинка: [x](https://…/img.png)">
              <textarea class="input" rows={10} value={notes} onInput={(e) => setNotes(e.currentTarget.value)} />
            </Field>
            {gm && (
              <Field label="Заметки мастера">
                <textarea class="input" rows={4} value={gmnotes} onInput={(e) => setGmnotes(e.currentTarget.value)} />
              </Field>
            )}
            <div class="row" style={{ justifyContent: 'flex-end' }}>
              <Button onClick={() => setEdit(false)}>Отмена</Button>
              <Button kind="primary" onClick={save}>
                Сохранить
              </Button>
            </div>
          </>
        ) : (
          <>
            <div class="handout-text" dangerouslySetInnerHTML={{ __html: sanitizeChatHtml(formatText(h.notes || '', { id: 'h' })) }} />
            {gm && h.gmnotes && (
              <div class="handout-gm">
                <b>Мастеру:</b>
                <div dangerouslySetInnerHTML={{ __html: sanitizeChatHtml(formatText(h.gmnotes, { id: 'h' })) }} />
              </div>
            )}
            {canEdit && (
              <Button size="sm" icon="pencil" onClick={() => setEdit(true)}>
                Редактировать
              </Button>
            )}
          </>
        )}
        {gm && (
          <div class="perm-grid">
            <div>
              <h4>Видят</h4>
              <Toggle checked={(h.inJournals || []).includes('all')} onChange={() => toggle('inJournals', 'all')} label="Все игроки" />
              {players.map((m) => (
                <Toggle checked={(h.inJournals || []).includes(m.id)} onChange={() => toggle('inJournals', m.id)} label={m.displayName} />
              ))}
            </div>
            <div>
              <h4>Могут править</h4>
              <Toggle checked={(h.controlledBy || []).includes('all')} onChange={() => toggle('controlledBy', 'all')} label="Все игроки" />
              {players.map((m) => (
                <Toggle checked={(h.controlledBy || []).includes(m.id)} onChange={() => toggle('controlledBy', m.id)} label={m.displayName} />
              ))}
            </div>
          </div>
        )}
        {gm && (
          <Button
            size="sm"
            icon="eye"
            onClick={async () => {
              if (!(h.inJournals || []).includes('all')) await upd({ inJournals: [...new Set([...(h.inJournals || []), 'all'])] });
              net.request('handout:show', { handoutId: id });
              toast('Материал показан игрокам', 'ok');
            }}
          >
            Показать всем сейчас
          </Button>
        )}
      </div>
    </FloatingWindow>
  );
}

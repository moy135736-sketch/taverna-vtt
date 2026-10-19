import { useState, useEffect } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import { api } from './api.js';
import { OverlayHost, ContextMenuHost, Spinner, showError } from './ui/components.jsx';
import { AuthScreen, LobbyScreen } from './lobby/Lobby.jsx';

const GameApp = lazy(() => import('./game/GameApp.jsx'));

export function navigate(path, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new Event('taverna:navigate'));
}

function useLocation() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const upd = () => setPath(location.pathname);
    window.addEventListener('popstate', upd);
    window.addEventListener('taverna:navigate', upd);
    return () => {
      window.removeEventListener('popstate', upd);
      window.removeEventListener('taverna:navigate', upd);
    };
  }, []);
  return path;
}

export function App() {
  const [user, setUser] = useState(undefined);
  const path = useLocation();

  useEffect(() => {
    api
      .get('/api/auth/me')
      .then((d) => setUser(d.user))
      .catch(() => setUser(null));
  }, []);

  // ссылка-приглашение /join/КОД: после входа сразу садимся за стол
  const join = /^\/join\/([A-Za-z0-9]{4,16})\/?$/.exec(path);
  useEffect(() => {
    if (!join || !user) return;
    api
      .post('/api/games/join', { code: join[1] })
      .then((d) => navigate(`/game/${d.game.id}`, true))
      .catch((e) => {
        showError(e);
        navigate('/', true);
      });
  }, [join?.[1], user?.id]);

  let content;
  if (user === undefined) content = <Spinner />;
  else if (!user) content = <AuthScreen onAuth={setUser} inviteCode={join?.[1]} />;
  else if (join) content = <Spinner label="Входим за стол…" />;
  else {
    const m = /^\/game\/([^/]+)/.exec(path);
    if (m)
      content = (
        <Suspense fallback={<Spinner label="Расставляем стол…" />}>
          <GameApp gameId={decodeURIComponent(m[1])} user={user} />
        </Suspense>
      );
    else content = <LobbyScreen user={user} setUser={setUser} />;
  }

  return (
    <>
      {content}
      <OverlayHost />
      <ContextMenuHost />
    </>
  );
}

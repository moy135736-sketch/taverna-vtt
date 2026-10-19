// Режим обслуживания: пока данные подменяются из резервной копии, сервер не принимает игроков и запросы
export const maintenance = {
  active: false,
  reason: '',
  on(reason) {
    this.active = true;
    this.reason = reason || 'Сервер обслуживается, подождите минуту';
  },
  off() {
    this.active = false;
    this.reason = '';
  },
};

/** Express: во время обслуживания — 503 для всего, кроме проверки состояния и хода восстановления */
export function maintenanceGuard(req, res, next) {
  if (!maintenance.active) return next();
  if (req.path === '/api/health' || req.path === '/api/admin/restore/status') return next();
  res.setHeader('Retry-After', '20');
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return res.status(503).json({ error: maintenance.reason, maintenance: true });
  next();
}

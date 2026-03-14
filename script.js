const App = (() => {
  const ENDPOINTS = {
    GEO_NAME: 'https://geocoding-api.open-meteo.com/v1/search',
    GEO_REV: 'https://geocoding-api.open-meteo.com/v1/reverse',
    FORECAST: 'https://api.open-meteo.com/v1/forecast'
  };

  const ELEMENTS = {
    LIST: 'weatherContainer',
    AUTOCOMPLETE: 'suggestions',
    ERROR_BOX: 'cityError',
    INPUT: 'cityInput',
    BTN_REFRESH: 'refreshBtn',
    BTN_ADD: 'addCityBtn',
    BTN_GEO: 'geoBtn',
    LOCATION_LABEL: 'currentLocation'
  };

  const OPTS = {
    AUTOCOMPLETE_DELAY: 250,
    SUGGEST_LIMIT: 8,
    GEO_LIMIT: 5,
    FORECAST_DAYS: 3,
    GEO_WAIT_MS: 10000,
    CACHE_TTL_MS: 5 * 60 * 1000,
    MAX_CONCURRENT: 3
  };

  const $id = (i) => document.getElementById(i);

  function safeParse(raw, fallback) {
    try {
      if (raw === null || typeof raw === 'undefined') return fallback;
      const parsed = JSON.parse(raw);
      return parsed === null ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  const storage = {
    load(k, d) {
      try { return safeParse(localStorage.getItem(k), d); } catch (e) { return d; }
    },
    save(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
    }
  };

  function randId(n = 7) { return Math.random().toString(36).slice(2, 2 + n); }

  function esc(s) { return String(s).replace(/[&<>"']/g, (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m])); }

  function niceDate(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d)) return String(iso);
      const months = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
      return `${d.getDate()} ${months[d.getMonth()]}`;
    } catch (e) { return String(iso); }
  }

  function debounce(fn, t) {
    let timer = null;
    return (...a) => { clearTimeout(timer); timer = setTimeout(() => fn(...a), t); };
  }

  const CODE_MAP = {
    0: "Ясно",1: "Частично облачно",2: "Облачно",3: "Пасмурно",45: "Туман",48: "Туман с инеем",
    51: "Мелкий дождь",53: "Умеренный дождь",55: "Сильный дождь",61: "Дождь",63: "Сильный дождь",
    65: "Сильный дождь",71: "Снег",73: "Сильный снег",75: "Очень сильный снег",80: "Ливень",
    81: "Сильный ливень",82: "Очень сильный ливень",95: "Гроза",96: "Гроза с небольшим градом",99: "Гроза с градом"
  };

  async function geoSearch(name, limit = OPTS.SUGGEST_LIMIT) {
    const url = `${ENDPOINTS.GEO_NAME}?name=${encodeURIComponent(name)}&count=${limit}&language=ru&format=json`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('geocode error');
    return r.json();
  }

  async function geoReverse(lat, lon, limit = 1) {
    try {
      const url = `${ENDPOINTS.GEO_REV}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&count=${limit}&language=ru`;
      const r = await fetch(url);
      if (!r.ok) return null;
      return r.json();
    } catch (e) { return null; }
  }

  class RequestPool {
    constructor(max = OPTS.MAX_CONCURRENT) { this.max = max; this.running = 0; this.queue = []; }
    push(task) { return new Promise((res, rej) => { this.queue.push({task, res, rej}); this._next(); }); }
    _next() {
      if (this.running >= this.max || this.queue.length === 0) return;
      const item = this.queue.shift(); this.running++;
      Promise.resolve().then(() => item.task()).then(v => { item.res(v); }).catch(e => { item.rej(e); }).finally(() => { this.running--; this._next(); });
    }
  }

  const pool = new RequestPool(OPTS.MAX_CONCURRENT);
  const forecastCache = new Map();

  function coordsKey(lat, lon) { return `${(Math.round(lat * 1e6) / 1e6).toFixed(6)},${(Math.round(lon * 1e6) / 1e6).toFixed(6)}`; }

  async function fetchForecast(lat, lon, days = OPTS.FORECAST_DAYS, force = false) {
    const key = coordsKey(lat, lon);
    const now = Date.now();
    if (!force && forecastCache.has(key)) {
      const item = forecastCache.get(key);
      if (now - item.ts < OPTS.CACHE_TTL_MS) return item.data;
    }
    const task = () => fetch(`${ENDPOINTS.FORECAST}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days=${days}`).then(r => { if (!r.ok) throw new Error('forecast error'); return r.json(); });
    const res = await pool.push(task);
    forecastCache.set(key, { ts: now, data: res });
    return res;
  }

  class WeatherController {
    constructor() {
      this.view = {
        container: $id(ELEMENTS.LIST),
        suggestions: $id(ELEMENTS.AUTOCOMPLETE),
        error: $id(ELEMENTS.ERROR_BOX),
        input: $id(ELEMENTS.INPUT),
        refreshBtn: $id(ELEMENTS.BTN_REFRESH),
        addBtn: $id(ELEMENTS.BTN_ADD),
        geoBtn: $id(ELEMENTS.BTN_GEO),
        locationLabel: $id(ELEMENTS.LOCATION_LABEL)
      };
      this.savedCities = storage.load('cities', []) || [];
      this.picked = null;
      this.cache = new Map();
      this._attach();
      if (this.view.suggestions) { this.view.suggestions.style.display = 'none'; this.view.suggestions.innerHTML = ''; }
    }

    _attach() {
      if (this.view.input) {
        this.view.input.addEventListener('input', debounce(() => this._handleType(), OPTS.AUTOCOMPLETE_DELAY));
        this.view.input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this.addFromInput(); }
          if (e.key === 'Escape' && this.view.suggestions) { this.view.suggestions.style.display = 'none'; this.view.suggestions.innerHTML = ''; }
        });
      }
      if (this.view.suggestions) {
        this.view.suggestions.addEventListener('click', (e) => {
          const li = e.target.closest('li'); if (!li) return;
          const lat = parseFloat(li.dataset.lat); const lon = parseFloat(li.dataset.lon);
          const disp = li.dataset.display || li.textContent.trim();
          this.picked = { name: disp.split(',')[0].trim(), display: disp, lat, lon };
          this.view.input.value = disp;
          this.view.suggestions.style.display = 'none'; this.view.suggestions.innerHTML = '';
        });
      }
      document.addEventListener('click', (e) => {
        if (this.view.input && !this.view.input.contains(e.target) && this.view.suggestions && !this.view.suggestions.contains(e.target)) {
          this.view.suggestions.style.display = 'none'; this.view.suggestions.innerHTML = '';
        }
      });
      if (this.view.refreshBtn) this.view.refreshBtn.addEventListener('click', () => this.refreshAll(true));
      if (this.view.addBtn) this.view.addBtn.addEventListener('click', () => this.addFromInput());
      if (this.view.geoBtn) this.view.geoBtn.addEventListener('click', () => this.applyGeo(true));
    }

    async _handleType() {
      const q = (this.view.input && this.view.input.value) ? this.view.input.value.trim() : '';
      this.picked = null;
      if (this.view.error) this.view.error.textContent = '';
      if (!q) { if (this.view.suggestions) { this.view.suggestions.style.display = 'none'; this.view.suggestions.innerHTML = ''; } return; }
      if (this.cache.has(q)) { this._showSuggestions(this.cache.get(q)); return; }
      try {
        const data = await geoSearch(q, OPTS.SUGGEST_LIMIT);
        const list = (data && data.results) ? data.results : [];
        this.cache.set(q, list);
        this._showSuggestions(list);
      } catch (err) {
        if (this.view.suggestions) this.view.suggestions.style.display = 'none';
      }
    }

    _showSuggestions(items) {
      if (!this.view.suggestions) return;
      if (!items || items.length === 0) { this.view.suggestions.style.display = 'none'; this.view.suggestions.innerHTML = ''; return; }
      this.view.suggestions.innerHTML = items.map(r => {
        const label = `${r.name}${r.admin1 ? ', ' + r.admin1 : ''}${r.country ? ', ' + r.country : ''}`;
        return `<li data-lat="${r.latitude}" data-lon="${r.longitude}" data-display="${esc(label)}">${esc(label)}</li>`;
      }).join('');
      this.view.suggestions.style.display = 'block';
    }

    async addFromInput() {
      const raw = (this.view.input && this.view.input.value) ? this.view.input.value.trim() : '';
      if (this.view.error) this.view.error.textContent = '';
      if (!raw) { if (this.view.error) this.view.error.textContent = 'Введите название города'; return; }
      try {
        if (this.picked && this.picked.display === raw) {
          const sel = this.picked;
          if (this._dupCoords(sel.lat, sel.lon)) { if (this.view.error) this.view.error.textContent = 'Этот город уже добавлен'; return; }
          this.savedCities.push({ id: randId(), name: sel.name, displayName: sel.display, lat: sel.lat, lon: sel.lon, isGeo: false });
          storage.save('cities', this.savedCities);
          this.view.input.value = '';
          this.picked = null;
          this.renderAll();
          return;
        }
        if (this.view.error) this.view.error.textContent = 'Проверка';
        const geo = await geoSearch(raw, OPTS.GEO_LIMIT);
        if (!geo.results || geo.results.length === 0) { if (this.view.error) this.view.error.textContent = 'Город не найден'; return; }
        const best = geo.results[0];
        if (this._dupCoords(best.latitude, best.longitude)) { if (this.view.error) this.view.error.textContent = 'Этот город уже добавлен'; return; }
        const display = `${best.name}${best.admin1 ? ', ' + best.admin1 : ''}${best.country ? ', ' + best.country : ''}`;
        this.savedCities.push({ id: randId(), name: best.name, displayName: display, lat: best.latitude, lon: best.longitude, isGeo: false });
        storage.save('cities', this.savedCities);
        this.view.input.value = '';
        if (this.view.error) this.view.error.textContent = '';
        this.renderAll();
      } catch (err) {
        if (this.view.error) this.view.error.textContent = 'Ошибка сети';
      }
    }

    _dupCoords(lat, lon) {
      const key = coordsKey(lat, lon);
      return Array.isArray(this.savedCities) && this.savedCities.some(c => coordsKey(c.lat || 0, c.lon || 0) === key);
    }

    renderAll() {
      if (!this.view.container) return;
      this.view.container.innerHTML = '';
      if (!Array.isArray(this.savedCities) || this.savedCities.length === 0) {
        this.view.container.innerHTML = `<p class="loading">Нет сохранённых городов</p>`;
        this._updateHeader();
        return;
      }
      const nodes = [];
      for (const c of this.savedCities) {
        const card = this._buildCard(c);
        nodes.push(card);
      }
      nodes.forEach(n => this.view.container.appendChild(n));
      const fills = this.savedCities.map((c, i) => this._populateCard(c, nodes[i]));
      return Promise.all(fills).then(() => this._updateHeader()).catch(() => this._updateHeader());
    }

    _buildCard(city) {
      const wrap = document.createElement('div');
      wrap.className = 'weather-card'; wrap.dataset.id = city.id;
      wrap.innerHTML = `
        <div class="card-top">
          <div>
            <div class="card-title">${esc(city.displayName || city.name)}</div>
            <div class="card-meta">${city.isGeo ? 'Ваше текущее местоположение' : 'Город'}</div>
          </div>
          <div class="card-actions"><button class="btn remove-card">Удалить</button></div>
        </div>
        <div class="card-body"><p class="loading">Загрузка</p></div>
      `;
      const rem = wrap.querySelector('.remove-card');
      rem.addEventListener('click', () => {
        const wasGeo = this.savedCities.find(x => x.id === city.id && x.isGeo);
        this.savedCities = this.savedCities.filter(x => x.id !== city.id);
        storage.save('cities', this.savedCities);
        this.renderAll();
        if (wasGeo) this._updateHeader();
      });
      return wrap;
    }

    async _populateCard(city, elCard, force = false) {
      const body = elCard.querySelector('.card-body'); if (!body) return;
      body.innerHTML = `<p class="loading">Загрузка</p>`;
      try {
        let { lat, lon } = city;
        if ((!lat || !lon) && !city.isGeo) {
          const g = await geoSearch(city.name, 1);
          if (!g.results || g.results.length === 0) { body.innerHTML = `<p class="error">Город не найден.</p>`; return; }
          const best = g.results[0];
          lat = best.latitude; lon = best.longitude; city.lat = lat; city.lon = lon; storage.save('cities', this.savedCities);
        }
        const fx = await fetchForecast(lat, lon, OPTS.FORECAST_DAYS, force);
        const times = (fx.daily && fx.daily.time) ? fx.daily.time : [];
        const tmin = (fx.daily && fx.daily.temperature_2m_min) ? fx.daily.temperature_2m_min : [];
        const tmax = (fx.daily && fx.daily.temperature_2m_max) ? fx.daily.temperature_2m_max : [];
        const codes = (fx.daily && fx.daily.weathercode) ? fx.daily.weathercode : [];
        let html = '';
        for (let i = 0; i < 3; i++) {
          const label = (i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : 'Послезавтра');
          const timeVal = times[i] || null;
          const minV = (typeof tmin[i] !== 'undefined') ? Math.round(tmin[i]) : '—';
          const maxV = (typeof tmax[i] !== 'undefined') ? Math.round(tmax[i]) : '—';
          const text = (typeof codes[i] !== 'undefined' && CODE_MAP[codes[i]]) ? CODE_MAP[codes[i]] : '—';
          html += `<div class="day"><div><b>${label}${timeVal ? ` (${niceDate(timeVal)})` : ''}:</b><div class="desc">${esc(text)}</div></div><div class="temps">${minV}°C — ${maxV}°C</div></div>`;
        }
        body.innerHTML = html;
      } catch (err) {
        body.innerHTML = `<p class="error">Ошибка загрузки: ${esc(err.message || 'ошибка')}</p>`;
      }
    }

    async refreshAll(force = false) {
      forecastCache.clear();
      const cards = Array.from(document.querySelectorAll('.weather-card'));
      const promises = cards.map(c => {
        const id = c.dataset.id; const city = this.savedCities.find(x => x.id === id);
        if (city) return this._populateCard(city, c, force); return Promise.resolve();
      });
      return Promise.all(promises);
    }

    _getPos(opts = {}) {
      return new Promise((res, rej) => {
        if (!navigator.geolocation) return rej(new Error('Геолокация не поддерживается'));
        navigator.geolocation.getCurrentPosition(res, rej, opts);
      });
    }

    async applyGeo(showErr = true) {
      try {
        const pos = await this._getPos({ timeout: OPTS.GEO_WAIT_MS });
        const lat = pos.coords.latitude; const lon = pos.coords.longitude;
        let disp = null;
        const rev = await geoReverse(lat, lon, 1);
        if (rev && rev.results && rev.results[0]) {
          const r = rev.results[0];
          disp = `${r.name}${r.admin1 ? ', ' + r.admin1 : ''}${r.country ? ', ' + r.country : ''}`;
        }
        if (!disp) disp = 'Текущее местоположение';
        const existing = Array.isArray(this.savedCities) ? this.savedCities.find(x => x.isGeo) : undefined;
        if (existing) {
          existing.lat = lat; existing.lon = lon; existing.displayName = disp;
          storage.save('cities', this.savedCities); this.renderAll();
        } else {
          const item = { id: randId(), name: 'geo', displayName: disp, lat, lon, isGeo: true };
          this.savedCities.unshift(item); storage.save('cities', this.savedCities); this.renderAll();
        }
        this._updateHeader();
        if (this.view.error) this.view.error.textContent = '';
      } catch (err) {
        if (!showErr) return;
        if (err && err.code === 1 && this.view.error) this.view.error.textContent = 'Доступ к геопозиции запрещён';
        else if (this.view.error) this.view.error.textContent = 'Не удалось получить геопозицию';
      }
    }

    _updateHeader() {
      const geo = Array.isArray(this.savedCities) ? this.savedCities.find(c => c.isGeo) : null;
      if (this.view.locationLabel) {
        if (geo) this.view.locationLabel.textContent = `Местоположение: ${geo.displayName || 'Текущее местоположение'}`;
        else this.view.locationLabel.textContent = '';
      }
    }

    async start() {
      if ((!this.savedCities || this.savedCities.length === 0) && navigator.geolocation) {
        try { await this.applyGeo(false); } catch (e) {}
      }
      this.renderAll();
    }
  }

  return new WeatherController();
})();

document.addEventListener('DOMContentLoaded', () => { if (typeof App.start === 'function') App.start(); });

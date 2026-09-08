import React, { useState, useEffect, useCallback, useRef } from "react";
import { Lock, Plus, X, LogOut, Pencil, Trash2, Users, Radio } from "lucide-react";

/* ---------------------------------------------------------------------- */
/*  ADMIN-ONLY BUILD                                                      */
/*  This is the Race Director / admin half of F1C Race Control, split    */
/*  out into its own standalone site so it can be deployed and shared    */
/*  with a separate URL from the driver console. It still talks to the   */
/*  exact same Firebase Realtime Database node as the driver site -      */
/*  DATABASE_URL and STATE_PATH below MUST always match the driver       */
/*  build's values, or the two sites will simply be looking at           */
/*  different data.                                                      */
/* ---------------------------------------------------------------------- */

/* ---------------------------------------------------------------------- */
/*  FIREBASE REALTIME DATABASE — VIA REST, NOT THE SDK                    */
/*  The firebase/database SDK opens a persistent WebSocket, which has     */
/*  proven unreliable on some mobile networks (connects to the Console   */
/*  fine over normal HTTPS, but the WebSocket handshake for onValue()    */
/*  never completes -> "No response from Firebase after 8 seconds").     */
/*  Plain REST (fetch + short polling) avoids that failure mode          */
/*  entirely and needs no extra npm package.                             */
/* ---------------------------------------------------------------------- */

const DATABASE_URL = "https://f1c-race-control-1f893-default-rtdb.asia-southeast1.firebasedatabase.app";
const STATE_PATH = "f1c-race-control-state";

// The admin panel's own actions already apply instantly via the local
// optimistic update in mutate(), so it doesn't need to poll fast - it's
// only listening for changes made by OTHER admins or new driver
// registrations, which aren't time-critical.
const POLL_MS = 2000;

/* ---------------------------------------------------------------------- */
/*  CONSTANTS                                                             */
/* ---------------------------------------------------------------------- */

const ADMIN_PASSCODE = "F1CADMIN";

const INK = "#0A0A0A";
const RED = "#E10600";
const RED_DARK = "#B80500";
const YELLOW = "#FFD400";
const GREEN = "#00A651";
const BLUE = "#0057FF";
const MUTED = "#8A8A8A";
const MUTED_DARK = "#5C5C5C";
const LINE = "#2A2A2A";

const COLORS = {
  red: { bg: RED, text: "#FFFFFF", border: RED },
  yellow: { bg: YELLOW, text: "#0A0A0A", border: YELLOW },
  green: { bg: GREEN, text: "#FFFFFF", border: GREEN },
  blue: { bg: BLUE, text: "#FFFFFF", border: BLUE },
  black: { bg: "#0A0A0A", text: "#FFFFFF", border: "#FFFFFF" },
  white: { bg: "#FFFFFF", text: "#0A0A0A", border: "#FFFFFF" },
};
const COLOR_ORDER = ["red", "yellow", "green", "blue", "black", "white"];
const COLOR_LABEL = {
  red: "Merah",
  yellow: "Kuning",
  green: "Hijau",
  blue: "Biru",
  black: "Hitam",
  white: "Putih",
};

// Kept identical to the driver build's defaultState/normalizeState shape.
// This app writes the WHOLE state object back on every save (mutate), so if
// this shape ever drifts from the driver build's shape, an admin action
// could silently wipe out fields the driver build expects. Keep these two
// schemas in sync any time either build's data shape changes.
const defaultState = () => ({
  lobbyOpen: true,
  drivers: [],
  raceInfoItems: [
    { id: "red-light", name: "RED LIGHT", color: "red" },
    { id: "green-light", name: "GREEN LIGHT", color: "green" },
    { id: "safety-car-out", name: "SAFETY CAR OUT", color: "yellow" },
    { id: "safety-car-in", name: "SAFETY CAR IN", color: "yellow" },
    { id: "no-overtake", name: "NO OVERTAKE", color: "blue" },
    { id: "no-closing-gap", name: "NO CLOSING GAP", color: "blue" },
  ],
  flags: [
    { id: "yellow-flag", name: "YELLOW FLAG", color: "yellow", target: false },
    { id: "chequered-flag", name: "CHEQUERED FLAG", color: "black", target: false },
    { id: "blue-flag", name: "BLUE FLAG", color: "blue", target: true },
    { id: "black-flag", name: "BLACK FLAG", color: "black", target: true },
    { id: "white-flag", name: "WHITE FLAG", color: "white", target: true },
    { id: "black-white-flag", name: "BLACK & WHITE FLAG", color: "black", target: true },
  ],
  penalties: [
    { id: "penalty-5s", name: "5 SEC TIME PENALTY", color: "red", target: true },
    { id: "penalty-10s", name: "10 SEC TIME PENALTY", color: "red", target: true },
    { id: "penalty-drivethrough", name: "DRIVE THROUGH PENALTY", color: "red", target: true },
    { id: "penalty-stopgo", name: "STOP & GO PENALTY", color: "red", target: true },
    { id: "penalty-tracklimits", name: "TRACK LIMITS WARNING", color: "yellow", target: true },
    { id: "penalty-dsq", name: "DISQUALIFICATION", color: "black", target: true },
  ],
  activeSignals: [],
  // Permanent log of every penalty ever handed to a driver - separate from
  // activeSignals (which only holds what's currently live/on-screen) so a
  // driver's penalty record survives even after the live signal is cleared
  // or the driver is later removed from the roster.
  penaltyHistory: [],
  updatedAt: 0,
});

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Splits a label like "SC IN [DRIVER 90KM/H]" into a main line ("SC IN") and
// a secondary bracketed line ("[DRIVER 90KM/H]") so long qualifier text gets
// its own smaller row instead of cramming onto one line in a narrow card.
function splitLabel(name) {
  const idx = name.indexOf("[");
  if (idx === -1) return { main: name, sub: null };
  const main = name.slice(0, idx).trim();
  const sub = name.slice(idx).trim();
  return { main: main || name, sub: main ? sub : null };
}

// Guarantees every expected field exists and is the right shape, no matter
// what is actually sitting in the database (partial writes, manual edits in
// the Firebase console, leftovers from an earlier test, etc). Without this,
// a single malformed field crashes the whole app with "cannot read
// properties of undefined".
function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== "object") return base;
  return {
    ...base,
    ...raw,
    lobbyOpen: typeof raw.lobbyOpen === "boolean" ? raw.lobbyOpen : base.lobbyOpen,
    drivers: Array.isArray(raw.drivers) ? raw.drivers : base.drivers,
    raceInfoItems: Array.isArray(raw.raceInfoItems) ? raw.raceInfoItems : base.raceInfoItems,
    flags: Array.isArray(raw.flags) ? raw.flags : base.flags,
    penalties: Array.isArray(raw.penalties) ? raw.penalties : base.penalties,
    activeSignals: Array.isArray(raw.activeSignals) ? raw.activeSignals : base.activeSignals,
    penaltyHistory: Array.isArray(raw.penaltyHistory) ? raw.penaltyHistory : base.penaltyHistory,
  };
}

/* ---------------------------------------------------------------------- */
/*  FIREBASE REST READ / WRITE / POLL HELPERS                             */
/*  No persistent connection is kept open. subscribeToState() fires       */
/*  immediately with the current value, then re-fetches every POLL_MS -   */
/*  that's what keeps this admin panel in sync with the driver site.      */
/* ---------------------------------------------------------------------- */

async function fetchState() {
  const res = await fetch(`${DATABASE_URL}/${STATE_PATH}.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Firebase REST error: HTTP ${res.status}`);
  return res.json();
}

async function saveState(next) {
  const payload = { ...next, updatedAt: Date.now() };
  const res = await fetch(`${DATABASE_URL}/${STATE_PATH}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Firebase REST error: HTTP ${res.status}`);
  return payload;
}

function subscribeToState(onData, onError, pollMs = POLL_MS) {
  let stopped = false;
  let intervalId = null;

  const poll = async () => {
    try {
      const data = await fetchState();
      if (stopped) return;
      if (data) {
        onData(normalizeState(data));
      } else {
        // Nothing in the database yet - seed it with the defaults.
        const fresh = defaultState();
        await saveState(fresh);
        if (!stopped) onData(fresh);
      }
      if (!stopped) onError(null);
    } catch (e) {
      if (!stopped) onError(e.message || String(e));
    }
  };

  const start = () => {
    if (intervalId) return;
    poll();
    intervalId = setInterval(poll, pollMs);
  };

  const stop = () => {
    if (!intervalId) return;
    clearInterval(intervalId);
    intervalId = null;
  };

  const handleVisibility = () => {
    if (document.visibilityState === "visible") {
      start();
    } else {
      stop();
    }
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleVisibility);
  }

  start();

  return () => {
    stopped = true;
    stop();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleVisibility);
    }
  };
}

/* ---------------------------------------------------------------------- */
/*  GLOBAL STYLE (plain CSS - always applies, no build step needed)       */
/* ---------------------------------------------------------------------- */

function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800;900&display=swap');
      .f1-root, .f1-root * { box-sizing: border-box; }
      .f1-root { font-family: 'Barlow Condensed','Arial Narrow',sans-serif; }
      .f1-btn-primary { background:${RED}; color:#fff; border:none; transition: background .15s ease; }
      .f1-btn-primary:hover { background:${RED_DARK}; }
      .f1-btn-white { background:#fff; color:${INK}; border:none; transition: background .15s ease; }
      .f1-btn-white:hover { background:#d6d6d6; }
      .f1-btn-outline { background:transparent; color:#fff; border:1px solid #525252; transition: border-color .15s ease; }
      .f1-btn-outline:hover { border-color:#fff; }
      .f1-input { background:transparent; color:#fff; border:1px solid #525252; outline:none; transition:border-color .15s ease; }
      .f1-input::placeholder { color:#666; }
      .f1-input:focus { border-color:${RED}; }
      .f1-input-w:focus { border-color:#fff; }
      .f1-link { color:${MUTED}; transition:color .15s ease; background:none; border:none; }
      .f1-link:hover { color:#fff; }
      .f1-card-edit { color:#555; background:none; border:none; }
      .f1-card-edit:hover { color:#fff; }
      .f1-swatch { background:transparent; border:1px solid #444; color:${MUTED}; transition: all .15s ease; }
      .f1-swatch-active { border-color:#fff; color:#fff; }
      .f1-chip-x { background:none; border:none; }
      .f1-chip-x:hover { opacity:0.7; }

      @media (max-width: 520px) {
        .f1-item-card { min-height: 62px; }
      }
    `}</style>
  );
}

/* ---------------------------------------------------------------------- */
/*  SMALL UI PRIMITIVES                                                   */
/* ---------------------------------------------------------------------- */

function Label({ children }) {
  return (
    <p className="font-semibold uppercase" style={{ fontSize: 11, letterSpacing: "0.3em", color: MUTED }}>
      {children}
    </p>
  );
}

function PrimaryButton({ children, onClick, icon: Icon, className = "" }) {
  return (
    <button
      onClick={onClick}
      className={`f1-btn-primary w-full flex items-center justify-center gap-3 active:scale-95 transition-transform font-black uppercase py-5 text-lg ${className}`}
      style={{ letterSpacing: "0.05em" }}
    >
      {Icon && <Icon size={20} strokeWidth={2.5} />}
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------------- */
/*  ADMIN LOGIN                                                            */
/* ---------------------------------------------------------------------- */

function AdminLoginView({ onSuccess }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  const submit = () => {
    if (code.trim().toUpperCase() === ADMIN_PASSCODE) {
      onSuccess();
    } else {
      setError("Invalid passcode. Access denied.");
    }
  };

  return (
    <div className="f1-root min-h-screen flex flex-col justify-center px-6 py-16" style={{ background: INK, color: "#fff" }}>
      <div className="max-w-md mx-auto w-full">
        <div className="flex items-center gap-2 mb-3" style={{ color: RED }}>
          <Lock size={15} />
          <span className="uppercase font-bold" style={{ fontSize: 12, letterSpacing: "0.3em" }}>
            Restricted Zone
          </span>
        </div>
        <h2 className="font-black uppercase" style={{ fontSize: 34, marginBottom: 28 }}>
          Admin Access
        </h2>

        <Label>Password</Label>
        <input
          type="password"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setError("");
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="ONLY FOR F1C & FRL STAFF"
          className="f1-input w-full mt-2 mb-4 px-4 py-4 uppercase font-bold text-sm"
          style={{ letterSpacing: "0.05em" }}
        />
        {error && (
          <p className="uppercase font-bold mb-4" style={{ color: RED, fontSize: 12, letterSpacing: "0.02em" }}>
            {error}
          </p>
        )}

        <PrimaryButton onClick={submit}>Enter Race Control</PrimaryButton>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  DRIVER SELECT MODAL                                                    */
/* ---------------------------------------------------------------------- */

function DriverSelectModal({ drivers, onPick, onClose, label }) {
  return (
    <div className="fixed inset-0 flex items-end sm:items-center justify-center px-4 pb-4 sm:pb-0" style={{ background: "rgba(0,0,0,0.8)", zIndex: 50 }}>
      <div className="w-full max-w-md flex flex-col" style={{ background: INK, border: `1px solid ${LINE}`, maxHeight: "75vh" }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${LINE}` }}>
          <div>
            <p className="font-semibold uppercase" style={{ fontSize: 10, letterSpacing: "0.3em", color: MUTED }}>
              Select Driver
            </p>
            <p className="text-white font-black uppercase text-sm mt-0.5">{label}</p>
          </div>
          <button onClick={onClose} className="f1-link">
            <X size={20} />
          </button>
        </div>
        <div className="overflow-y-auto p-4 flex flex-col gap-2">
          {drivers.length === 0 && (
            <p className="text-center py-8 uppercase font-semibold" style={{ color: MUTED_DARK, fontSize: 13 }}>
              No drivers registered yet.
            </p>
          )}
          {drivers.map((d) => (
            <button key={d.id} onClick={() => onPick(d)} className="f1-driver-btn text-left px-4 py-3 font-bold uppercase text-sm" style={{ border: "1px solid #444", background: "transparent", color: "#fff" }}>
              {d.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  ITEM FORM MODAL (add / edit flag / penalty / race info)                */
/* ---------------------------------------------------------------------- */

function ItemFormModal({ title, initial, allowTarget, onSave, onDelete, onClose }) {
  const [name, setName] = useState(initial?.name || "");
  const [color, setColor] = useState(initial?.color || "red");
  const [target, setTarget] = useState(initial?.target ?? false);

  return (
    <div className="fixed inset-0 flex items-end sm:items-center justify-center px-4 pb-4 sm:pb-0" style={{ background: "rgba(0,0,0,0.8)", zIndex: 50 }}>
      <div className="w-full max-w-md" style={{ background: INK, border: `1px solid ${LINE}` }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${LINE}` }}>
          <p className="text-white font-black uppercase text-sm">{title}</p>
          <button onClick={onClose} className="f1-link">
            <X size={20} />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-5">
          <div>
            <Label>Name</Label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase())}
              placeholder="E.G. RED FLAG"
              className="f1-input f1-input-w w-full mt-2 px-4 py-3 font-bold uppercase text-sm"
            />
          </div>

          <div>
            <Label>Background Color</Label>
            <div className="grid grid-cols-3 gap-2 mt-2">
              {COLOR_ORDER.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase f1-swatch ${color === c ? "f1-swatch-active" : ""}`}
                >
                  <span className="rounded-full" style={{ width: 14, height: 14, background: COLORS[c].bg, border: "1px solid #555" }} />
                  {COLOR_LABEL[c]}
                </button>
              ))}
            </div>
          </div>

          {allowTarget && (
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={target}
                onChange={(e) => setTarget(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: RED }}
              />
              <span className="font-semibold uppercase" style={{ fontSize: 13, color: "#d4d4d4" }}>
                Requires driver target
              </span>
            </label>
          )}

          <div className="flex gap-3 pt-2">
            {initial && onDelete && (
              <button
                onClick={() => onDelete(initial.id)}
                className="flex items-center justify-center gap-2 font-black uppercase text-sm px-4 py-3"
                style={{ border: `1px solid ${RED}`, color: RED, background: "transparent" }}
              >
                <Trash2 size={15} /> Delete
              </button>
            )}
            <button
              onClick={() => {
                if (!name.trim()) return;
                onSave({
                  id: initial?.id || genId(),
                  name: name.trim().toUpperCase(),
                  color,
                  target: allowTarget ? target : false,
                });
              }}
              className="f1-btn-primary flex-1 font-black uppercase text-sm px-4 py-3"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  ADMIN CARD                                                             */
/* ---------------------------------------------------------------------- */

function ItemCard({ item, activeEntries, onToggle, onAddDriver, onRemoveDriver, onEdit }) {
  const palette = COLORS[item.color];
  const isActiveSimple = !item.target && activeEntries.length > 0;
  const hasActive = activeEntries.length > 0;
  const { main, sub } = splitLabel(item.name);

  return (
    <div
      className="relative flex flex-col gap-1 p-2 f1-item-card"
      style={{
        border: `1px solid ${hasActive ? palette.border : LINE}`,
        background: isActiveSimple ? `${palette.bg}22` : "transparent",
        minHeight: 62,
      }}
    >
      {onEdit && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit(item);
          }}
          className="f1-card-edit absolute top-1 right-1"
        >
          <Pencil size={11} />
        </button>
      )}

      <button onClick={() => (item.target ? onAddDriver(item) : onToggle(item))} className="text-left">
        <p className="font-black uppercase text-white pr-4" style={{ fontSize: 12, lineHeight: 1.15 }}>
          {main}
        </p>
        {sub && (
          <p className="font-bold uppercase" style={{ fontSize: 9, lineHeight: 1.2, color: MUTED, marginTop: 1 }}>
            {sub}
          </p>
        )}
        {item.target && (
          <p className="font-semibold mt-1" style={{ fontSize: 8, letterSpacing: "0.15em", color: MUTED_DARK }}>
            Driver Target
          </p>
        )}
        {isActiveSimple && (
          <p className="font-bold mt-1" style={{ fontSize: 8, letterSpacing: "0.15em", color: palette.bg }}>
            ● LIVE
          </p>
        )}
      </button>

      {item.target && activeEntries.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {activeEntries.map((entry) => (
            <span
              key={entry.uid}
              className="flex items-center gap-1 font-bold uppercase px-1.5 py-0.5"
              style={{ background: palette.bg, color: palette.text, fontSize: 9, letterSpacing: "0.02em" }}
            >
              {entry.driverName}
              <button onClick={() => onRemoveDriver(entry.uid)} className="f1-chip-x" style={{ color: palette.text }}>
                <X size={9} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  ADMIN PANEL                                                            */
/* ---------------------------------------------------------------------- */

function AdminPanel({ state, mutate, onLogout }) {
  const [pickerFor, setPickerFor] = useState(null); // { item, section }
  const [editing, setEditing] = useState(null); // { section, item }

  const activeFor = (itemId) => state.activeSignals.filter((s) => s.itemId === itemId);

  const toggleSimple = (item, section) => {
    const has = state.activeSignals.some((s) => s.itemId === item.id);
    const next = has
      ? state.activeSignals.filter((s) => s.itemId !== item.id)
      : [...state.activeSignals, { uid: genId(), section, itemId: item.id, name: item.name, color: item.color, target: false }];
    mutate({ activeSignals: next });
  };

  const addDriverSignal = (item, section, driver) => {
    const next = [
      ...state.activeSignals,
      { uid: genId(), section, itemId: item.id, name: item.name, color: item.color, target: true, driverName: driver.name },
    ];
    // Penalties get an extra, permanent record in penaltyHistory - this is
    // what feeds the "Penalty History" list below the driver roster. Flags
    // and race info stay live-only and are not logged here.
    const historyPatch =
      section === "penalties"
        ? {
            penaltyHistory: [
              ...state.penaltyHistory,
              { id: genId(), driverName: driver.name, penaltyName: item.name, color: item.color, timestamp: Date.now() },
            ],
          }
        : {};
    mutate({ activeSignals: next, ...historyPatch });
    setPickerFor(null);
  };

  const deletePenaltyHistoryEntry = (id) =>
    mutate({ penaltyHistory: state.penaltyHistory.filter((entry) => entry.id !== id) });

  const clearPenaltyHistory = () => mutate({ penaltyHistory: [] });

  const removeDriverSignal = (uid) => mutate({ activeSignals: state.activeSignals.filter((s) => s.uid !== uid) });

  const clearAll = () => mutate({ activeSignals: [] });

  const toggleLobby = () => mutate({ lobbyOpen: !state.lobbyOpen });

  const removeDriver = (id) =>
    mutate({
      drivers: state.drivers.filter((d) => d.id !== id),
      activeSignals: state.activeSignals.filter((s) => s.driverName !== state.drivers.find((d) => d.id === id)?.name),
    });

  const saveItem = (section, item) => {
    const list = state[section];
    const exists = list.some((i) => i.id === item.id);
    const nextList = exists ? list.map((i) => (i.id === item.id ? item : i)) : [...list, item];
    mutate({ [section]: nextList });
    setEditing(null);
  };

  const deleteItem = (section, id) => {
    mutate({
      [section]: state[section].filter((i) => i.id !== id),
      activeSignals: state.activeSignals.filter((s) => s.itemId !== id),
    });
    setEditing(null);
  };

  const Section = ({ title, section, items, allowTarget, countLabel, addLabel }) => (
    <div className="mb-3 p-3" style={{ border: `1px solid ${LINE}` }}>
      <div className="flex items-center justify-between mb-2.5 flex-wrap gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="font-black uppercase text-base text-white">{title}</h3>
          <span className="font-semibold" style={{ fontSize: 11, color: MUTED_DARK }}>
            {items.length} {countLabel}
          </span>
        </div>
        <button
          onClick={() => setEditing({ section, item: null })}
          className="f1-btn-white flex items-center gap-1 text-[11px] font-black uppercase px-2 py-1.5"
        >
          <Plus size={12} /> Add {addLabel}
        </button>
      </div>
      <div className="f1-item-grid grid grid-cols-3 sm:grid-cols-4 gap-1.5">
        {items.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            activeEntries={activeFor(item.id)}
            onToggle={() => toggleSimple(item, section)}
            onAddDriver={() => setPickerFor({ item, section })}
            onRemoveDriver={removeDriverSignal}
            onEdit={(it) => setEditing({ section, item: it })}
          />
        ))}
      </div>
    </div>
  );

  const liveCount = state.activeSignals.length;

  return (
    <div className="f1-root min-h-screen pb-16" style={{ background: INK, color: "#fff" }}>
      <div className="px-4 py-4" style={{ borderBottom: `1px solid ${LINE}`, background: INK }}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center" style={{ width: 36, height: 36, background: RED }}>
              <Radio size={17} className="text-white" />
            </div>
            <div>
              <p className="font-black uppercase text-white text-sm leading-none">F1C Race Control</p>
              <div className="flex items-center gap-2 mt-1">
                <span className="flex items-center gap-1 font-bold" style={{ fontSize: 10, color: GREEN, letterSpacing: "0.05em" }}>
                  <span className="rounded-full" style={{ width: 6, height: 6, background: GREEN }} /> LIVE
                </span>
                <span style={{ color: "#525252" }}>|</span>
                <span className="flex items-center gap-1 font-bold" style={{ fontSize: 10, color: "#a8a8a8", letterSpacing: "0.05em" }}>
                  <Users size={11} /> {state.drivers.length} DRIVERS
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={toggleLobby}
              className="flex items-center gap-2 px-3 py-2 text-xs font-black uppercase"
              style={{ border: `1px solid ${state.lobbyOpen ? GREEN : "#525252"}`, color: state.lobbyOpen ? GREEN : "#a8a8a8" }}
            >
              <span className="relative rounded-full" style={{ width: 32, height: 16, background: state.lobbyOpen ? GREEN : "#404040" }}>
                <span className="absolute rounded-full" style={{ top: 2, left: state.lobbyOpen ? 18 : 2, width: 12, height: 12, background: "#fff" }} />
              </span>
              Lobby {state.lobbyOpen ? "Open" : "Closed"}
            </button>
            <button onClick={clearAll} className="f1-btn-outline px-3 py-2 text-xs font-black uppercase">
              Clear All {liveCount > 0 && `(${liveCount})`}
            </button>
            <button onClick={onLogout} className="f1-btn-primary flex items-center gap-1.5 px-3 py-2 text-xs font-black uppercase">
              <LogOut size={13} /> Logout
            </button>
          </div>
        </div>
      </div>

      <div className="px-4 pt-5 max-w-2xl mx-auto">
        <Section title="Race Info" section="raceInfoItems" items={state.raceInfoItems} allowTarget={false} countLabel="controls" addLabel="Info" />
        <Section title="Flags" section="flags" items={state.flags} allowTarget={true} countLabel="flags" addLabel="Flag" />
        <Section title="Penalties" section="penalties" items={state.penalties} allowTarget={true} countLabel="penalties" addLabel="Penalty" />

        <div className="p-3" style={{ border: `1px dashed ${LINE}` }}>
          <h3 className="font-black uppercase text-base text-white mb-1">Registered Drivers</h3>
          <p className="font-semibold mb-3" style={{ fontSize: 11, color: MUTED_DARK }}>
            {state.drivers.length} drivers
          </p>
          {state.drivers.length === 0 ? (
            <p className="uppercase font-semibold text-center py-6" style={{ color: "#525252", fontSize: 13, border: `1px dashed ${LINE}` }}>
              No drivers registered yet.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {state.drivers.map((d) => (
                <div key={d.id} className="flex items-center justify-between px-3 py-2" style={{ border: `1px solid ${LINE}` }}>
                  <span className="text-white font-bold uppercase text-sm">{d.name}</span>
                  <button onClick={() => removeDriver(d.id)} className="f1-card-edit">
                    <X size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-3 p-3" style={{ border: `1px dashed ${LINE}` }}>
          <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
            <h3 className="font-black uppercase text-base text-white">Penalty History</h3>
            {state.penaltyHistory.length > 0 && (
              <button onClick={clearPenaltyHistory} className="f1-btn-outline text-[11px] font-black uppercase px-2 py-1.5">
                Clear History
              </button>
            )}
          </div>
          <p className="font-semibold mb-3" style={{ fontSize: 11, color: MUTED_DARK }}>
            {state.penaltyHistory.length} penalt{state.penaltyHistory.length === 1 ? "y" : "ies"} recorded
          </p>
          {state.penaltyHistory.length === 0 ? (
            <p className="uppercase font-semibold text-center py-6" style={{ color: "#525252", fontSize: 13, border: `1px dashed ${LINE}` }}>
              No penalties recorded yet.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {state.penaltyHistory.map((entry) => {
                const palette = COLORS[entry.color] || COLORS.red;
                return (
                  <div key={entry.id} className="flex items-center justify-between gap-2 px-3 py-2" style={{ border: `1px solid ${LINE}` }}>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="flex-shrink-0 rounded-full" style={{ width: 8, height: 8, background: palette.bg }} />
                      <div className="min-w-0">
                        <p className="text-white font-bold uppercase text-sm truncate">
                          {entry.driverName} — {entry.penaltyName}
                        </p>
                        <p className="font-semibold" style={{ fontSize: 10, color: MUTED_DARK }}>
                          {new Date(entry.timestamp).toLocaleString("id-ID")}
                        </p>
                      </div>
                    </div>
                    <button onClick={() => deletePenaltyHistoryEntry(entry.id)} className="f1-card-edit flex-shrink-0">
                      <X size={15} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {pickerFor && (
        <DriverSelectModal
          drivers={state.drivers}
          label={pickerFor.item.name}
          onPick={(driver) => addDriverSignal(pickerFor.item, pickerFor.section, driver)}
          onClose={() => setPickerFor(null)}
        />
      )}

      {editing && (
        <ItemFormModal
          title={editing.item ? `Edit ${editing.item.name}` : "Add New Item"}
          initial={editing.item}
          allowTarget={
            editing.section === "flags" || editing.section === "penalties"
          }
          onSave={(item) => saveItem(editing.section, item)}
          onDelete={editing.item ? (id) => deleteItem(editing.section, id) : undefined}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  ROOT APP                                                               */
/* ---------------------------------------------------------------------- */

export default function F1CAdminApp() {
  const [view, setView] = useState("login"); // "login" | "panel"
  const [state, setState] = useState(defaultState());
  const [ready, setReady] = useState(false);
  const [connError, setConnError] = useState(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const unsubscribe = subscribeToState(
      (incoming) => {
        // Guard against an out-of-order network echo overwriting a click that
        // just happened locally, so a toggle always reads as instant ON/OFF.
        if ((incoming.updatedAt || 0) >= (stateRef.current.updatedAt || 0)) {
          setState(incoming);
          stateRef.current = incoming;
        }
        setConnError(null);
        setReady(true);
      },
      (message) => {
        if (message) setConnError(message);
      },
      POLL_MS
    );

    return () => unsubscribe();
  }, []);

  const mutate = useCallback(async (partial) => {
    const merged = { ...stateRef.current, ...partial, updatedAt: Date.now() };
    // Apply instantly and locally first so the toggle feels immediate;
    // the Firebase echo will confirm the same data a moment later.
    setState(merged);
    stateRef.current = merged;
    try {
      await saveState(merged);
      setConnError(null);
    } catch (e) {
      setConnError(e.message || String(e));
      throw e;
    }
  }, []);

  if (connError) {
    return (
      <div className="f1-root min-h-screen flex flex-col items-center justify-center px-6 text-center gap-4" style={{ background: INK, color: "#fff" }}>
        <GlobalStyle />
        <span className="uppercase font-black" style={{ fontSize: 16, letterSpacing: "0.1em", color: RED }}>
          Firebase Connection Error
        </span>
        <p style={{ color: "#d4d4d4", fontSize: 13, maxWidth: 420, lineHeight: 1.6, whiteSpace: "pre-line" }}>
          {connError}
        </p>
        <p className="uppercase font-semibold" style={{ color: MUTED_DARK, fontSize: 11, letterSpacing: "0.1em", maxWidth: 420, lineHeight: 1.6 }}>
          Cek DATABASE_URL di App.jsx dan Realtime Database Rules di Firebase Console.
        </p>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="f1-root min-h-screen flex items-center justify-center" style={{ background: INK, color: "#fff" }}>
        <GlobalStyle />
        <span className="uppercase font-bold" style={{ fontSize: 12, letterSpacing: "0.3em", color: "#525252" }}>
          Loading race control…
        </span>
      </div>
    );
  }

  return (
    <div className="f1-root">
      <GlobalStyle />

      {view === "login" && <AdminLoginView onSuccess={() => setView("panel")} />}

      {view === "panel" && <AdminPanel state={state} mutate={mutate} onLogout={() => setView("login")} />}
    </div>
  );
}

// SPDX-FileCopyrightText: 2024 Nicco Kunzmann and Open Web Calendar Contributors <https://open-web-calendar.quelltext.eu/>
//
// SPDX-License-Identifier: GPL-2.0-only

(function () {
  const MOBILE_BREAKPOINT_FALLBACK = 600;
  const MOBILE_MODAL_OPEN_CLASS = "is-open";
  const MOBILE_VIEW_CLASS = "owc-mobile-active";
  const MOBILE_VIEWPORT_CLASS = "owc-mobile-viewport";
  const MODAL_FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const state = {
    initialized: false,
    scheduler: null,
    specification: null,
    root: null,
    calendarContainer: null,
    modal: {
      root: null,
      close: null,
      title: null,
      date: null,
      content: null,
      link: null,
    },
    listModal: {
      root: null,
      title: null,
      content: null,
    },
    selectedDate: null,
    viewMonth: null,
    eventMap: new Map(),
    lastFocusedElement: null,
    listeners: {
      click: null,
      modalClick: null,
      listModalClick: null,
      keydown: null,
      resize: null,
      onClickId: null,
      onXleId: null,
      onViewChangeId: null,
      // MutationObserver re-clusters after every dhtmlx render, with debouncing
      clusterObserver: null,
      clusterDebounceId: null,
    },
  };

  /**
   * Normalizes a date to the start of its day.
   * @param {Date} date - Date to normalize.
   * @returns {Date} A new local date at 00:00:00.
   */
  function _startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  /**
   * Creates the exclusive end bound for a day.
   * @param {Date} date - Day to build an end bound for.
   * @returns {Date} Start of the next day.
   */
  function _endOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  }

  /**
   * Returns whether two dates represent the same calendar day.
   * @param {Date} left - First date.
   * @param {Date} right - Second date.
   * @returns {boolean} True when year/month/day match.
   */
  function _isSameDay(left, right) {
    return (
      left.getFullYear() === right.getFullYear() &&
      left.getMonth() === right.getMonth() &&
      left.getDate() === right.getDate()
    );
  }

  /**
   * Formats a date as YYYY-MM-DD for dataset use.
   * @param {Date} date - Date to format.
   * @returns {string} Date key in local calendar format.
   */
  function _dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  /**
   * Parses a YYYY-MM-DD key into a local Date.
   * @param {string} key - Date key to parse.
   * @returns {Date|null} Parsed date or null when malformed.
   */
  function _parseDateKey(key) {
    const parts = String(key).split("-");
    if (parts.length !== 3) {
      return null;
    }
    const year = Number.parseInt(parts[0], 10);
    const month = Number.parseInt(parts[1], 10);
    const day = Number.parseInt(parts[2], 10);
    if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
      return null;
    }
    return new Date(year, month - 1, day);
  }

  /**
   * Checks whether the viewport is within the mobile layout breakpoint.
   * @param {Object} specification - Calendar specification object.
   * @returns {boolean} True when viewport width is below compact width.
   */
  function _isMobile(specification) {
    const parsed = Number.parseInt(specification?.compact_layout_width, 10);
    const compactWidth = Number.isNaN(parsed)
      ? MOBILE_BREAKPOINT_FALLBACK
      : parsed;
    return window.innerWidth < compactWidth;
  }

  /**
   * Gets enabled mobile header controls from specification.
   * @param {Object} specification - Calendar specification object.
   * @returns {Set<string>} Set of enabled control identifiers.
   */
  function _getControls(specification) {
    const controls = Array.isArray(specification?.controls)
      ? specification.controls
      : [];
    return new Set(controls);
  }

  /**
   * Gets weekday index for the start of the rendered week.
   * @returns {number} 0 for Sunday or 1 for Monday start.
   */
  function _getWeekStartIndex() {
    return state.scheduler?.config?.start_on_monday ? 1 : 0;
  }

  /**
   * Returns day events sorted by start time then id.
   * @param {Date} selectedDate - Day to read events for.
   * @returns {Object[]} Sorted scheduler events.
   */
  function _getDayEvents(selectedDate) {
    const dayStart = _startOfDay(selectedDate);
    const dayEnd = _endOfDay(selectedDate);
    return state.scheduler
      .getEvents(dayStart, dayEnd)
      .slice()
      .sort(function (left, right) {
        const startDelta = left.start_date - right.start_date;
        if (startDelta !== 0) {
          return startDelta;
        }
        return String(left.id).localeCompare(String(right.id));
      });
  }

  /**
   * Creates a debounced function wrapper.
   * @param {Function} callback - Function to debounce.
   * @param {number} milliseconds - Wait time before invocation.
   * @returns {Function} Debounced wrapper function.
   */
  function _debounce(callback, milliseconds) {
    let timerId = null;
    return function debouncedFunction() {
      const context = this;
      const args = arguments;
      clearTimeout(timerId);
      timerId = setTimeout(function () {
        callback.apply(context, args);
      }, milliseconds);
    };
  }

  /**
   * Creates a reusable mobile header action button.
   * @param {string} action - Data action name.
   * @param {string} label - Visible label for the button.
   * @param {string} className - Additional class names.
   * @returns {HTMLButtonElement} Configured button element.
   */
  function _createHeaderButton(action, label, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.dataset.owcAction = action;
    button.textContent = label;
    return button;
  }

  /**
   * Builds the compact month header, weekday row, and day cells.
   * @param {Date} monthDate - Date inside month to render.
   * @param {Object} scheduler - Scheduler API object.
   * @param {Object} specification - Calendar specification object.
   * @returns {DocumentFragment} Fragment with month calendar nodes.
   */
  function _renderMiniMonth(monthDate, scheduler, specification) {
    const fragment = document.createDocumentFragment();
    const controls = _getControls(specification);
    const localeDate = scheduler.locale?.date || {};
    const weekStart = _getWeekStartIndex();
    const header = document.createElement("div");
    header.className = "owc-mobile-month-header";

    if (controls.has("previous")) {
      header.appendChild(
        _createHeaderButton(
          "prev-month",
          "",
          "dhx_cal_prev_button dhx_cal_nav_button owc-mobile-nav-button"
        )
      );
    }

    if (controls.has("date")) {
      const monthLabel = document.createElement("div");
      const monthNames = Array.isArray(localeDate.month_full)
        ? localeDate.month_full
        : [];
      const monthName = monthNames[monthDate.getMonth()] || "";
      monthLabel.className = "owc-mobile-month-title";
      monthLabel.textContent = `${monthName} ${monthDate.getFullYear()}`.trim();
      header.appendChild(monthLabel);
    } else {
      const spacer = document.createElement("div");
      spacer.className = "owc-mobile-header-spacer";
      header.appendChild(spacer);
    }

    if (controls.has("today")) {
      const todayLabel = scheduler.locale?.labels?.today || "Today";
      header.appendChild(
        _createHeaderButton("today", todayLabel, "owc-mobile-today")
      );
    }

    if (controls.has("next")) {
      header.appendChild(
        _createHeaderButton(
          "next-month",
          "",
          "dhx_cal_next_button dhx_cal_nav_button owc-mobile-nav-button"
        )
      );
    }

    fragment.appendChild(header);

    const weekdayRow = document.createElement("div");
    weekdayRow.className = "owc-mobile-weekday-row";
    const dayNames = Array.isArray(localeDate.day_short) ? localeDate.day_short : [];
    for (let offset = 0; offset < 7; offset += 1) {
      const weekday = document.createElement("div");
      const dayIndex = (weekStart + offset) % 7;
      weekday.className = "owc-mobile-weekday";
      weekday.textContent = dayNames[dayIndex] || "";
      weekdayRow.appendChild(weekday);
    }
    fragment.appendChild(weekdayRow);

    const monthGrid = document.createElement("div");
    monthGrid.className = "owc-mobile-month-grid";

    const monthStart = scheduler.date.month_start(new Date(monthDate));
    const gridStart = new Date(monthStart);
    while (gridStart.getDay() !== weekStart) {
      gridStart.setDate(gridStart.getDate() - 1);
    }

    const today = _startOfDay(new Date());
    for (let index = 0; index < 42; index += 1) {
      const cellDate = scheduler.date.add(gridStart, index, "day");
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "owc-mobile-day-cell";
      cell.dataset.owcAction = "select-day";
      cell.dataset.owcDate = _dateKey(cellDate);

      if (cellDate.getMonth() !== monthStart.getMonth()) {
        cell.classList.add("is-other-month");
      }
      if (_isSameDay(cellDate, today)) {
        cell.classList.add("is-today");
      }
      if (_isSameDay(cellDate, state.selectedDate)) {
        cell.classList.add("is-selected");
      }

      const dateNumber = document.createElement("span");
      dateNumber.className = "owc-mobile-date-number";
      dateNumber.textContent = String(cellDate.getDate());
      cell.appendChild(dateNumber);

      const events = scheduler.getEvents(_startOfDay(cellDate), _endOfDay(cellDate));
      const dotRow = document.createElement("span");
      dotRow.className = "owc-mobile-dot-row";

      const dotCount = Math.min(events.length, 3);
      for (let dotIndex = 0; dotIndex < dotCount; dotIndex += 1) {
        const dot = document.createElement("span");
        dot.className = "owc-mobile-event-dot";
        dotRow.appendChild(dot);
      }
      if (events.length > 3) {
        const moreBadge = document.createElement("span");
        moreBadge.className = "owc-mobile-more-count";
        moreBadge.textContent = `+${events.length - 3}`;
        dotRow.appendChild(moreBadge);
      }
      cell.appendChild(dotRow);
      monthGrid.appendChild(cell);
    }

    fragment.appendChild(monthGrid);
    return fragment;
  }

  /**
   * Returns true when an event represents an all-day or multi-day all-day item:
   * - starts at midnight, ends at midnight
   * - duration is a non-zero multiple of 24h
   * dhtmlx doesn't carry an explicit all-day flag in its core event objects, so
   * this is inferred from the date bounds (matching how iCal `VALUE=DATE` is parsed
   * upstream into midnight-to-midnight ranges).
   * @param {Object} event - Scheduler event object.
   * @returns {boolean} True when the event spans full days.
   */
  function _isAllDayEvent(event) {
    if (!event || !event.start_date || !event.end_date) return false;
    const start = event.start_date;
    const end = event.end_date;
    const startsAtMidnight =
      start.getHours() === 0 &&
      start.getMinutes() === 0 &&
      start.getSeconds() === 0 &&
      start.getMilliseconds() === 0;
    const endsAtMidnight =
      end.getHours() === 0 &&
      end.getMinutes() === 0 &&
      end.getSeconds() === 0 &&
      end.getMilliseconds() === 0;
    if (!startsAtMidnight || !endsAtMidnight) return false;
    const durationMs = end.getTime() - start.getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;
    return durationMs >= oneDayMs && durationMs % oneDayMs === 0;
  }

  /**
   * Formats an event time range according to specification hour format.
   * All-day events return the localized "Full day" label (or "All day" fallback)
   * instead of the literal midnight time.
   * @param {Object} event - Scheduler event object.
   * @param {Object} scheduler - Scheduler API object.
   * @param {Object} specification - Calendar specification object.
   * @returns {string} Display string for the event time.
   */
  function _formatEventTime(event, scheduler, specification) {
    if (_isAllDayEvent(event)) {
      return scheduler.locale?.labels?.full_day || "All day";
    }
    const hourFormat = specification?.hour_format || "%H:%i";
    const formatTime = scheduler.date.date_to_str(hourFormat);
    const startText = formatTime(event.start_date);
    const endText = formatTime(event.end_date);
    return startText === endText ? startText : `${startText} - ${endText}`;
  }

  /**
   * Builds the selected-day event list panel.
   * @param {Date} selectedDate - Day to render.
   * @param {Object} scheduler - Scheduler API object.
   * @param {Object} specification - Calendar specification object.
   * @returns {DocumentFragment} Fragment with list heading and rows.
   */
  function _renderDayList(selectedDate, scheduler, specification) {
    const fragment = document.createDocumentFragment();
    const localeDate = scheduler.locale?.date || {};
    const monthNames = Array.isArray(localeDate.month_full)
      ? localeDate.month_full
      : [];
    const selectedLabel = document.createElement("h3");
    selectedLabel.className = "owc-mobile-selected-date";
    selectedLabel.textContent = `${monthNames[selectedDate.getMonth()] || ""} ${selectedDate.getDate()}`;
    fragment.appendChild(selectedLabel);

    const list = document.createElement("div");
    list.className = "owc-mobile-day-list";
    state.eventMap.clear();

    const events = _getDayEvents(selectedDate);
    if (!events.length) {
      const empty = document.createElement("div");
      empty.className = "owc-mobile-empty-state";
      empty.textContent = scheduler.locale?.labels?.no_events || "\u2014";
      list.appendChild(empty);
      fragment.appendChild(list);
      return fragment;
    }

    events.forEach(function (event, index) {
      const key = `${event.id || index}:${event.start_date?.getTime?.() || index}:${index}`;
      state.eventMap.set(key, event);

      const row = document.createElement("button");
      row.type = "button";
      row.className = "owc-mobile-day-list-item";
      row.dataset.owcAction = "open-event";
      row.dataset.owcEventKey = key;

      const cssClasses = Array.isArray(event["css-classes"])
        ? event["css-classes"]
        : [];
      cssClasses.forEach(function (className) {
        if (typeof className === "string" && className.trim()) {
          row.classList.add(className);
        }
      });

      const time = document.createElement("span");
      time.className = "owc-mobile-event-time";
      time.textContent = _formatEventTime(event, scheduler, specification);
      row.appendChild(time);

      const summary = document.createElement("span");
      summary.className = "owc-mobile-event-summary";
      summary.textContent = event.text || "";
      row.appendChild(summary);

      list.appendChild(row);
    });

    fragment.appendChild(list);
    return fragment;
  }

  /**
   * Returns a focusable elements list for a modal.
   * @param {HTMLElement} modalElement - Modal root element.
   * @returns {HTMLElement[]} Focusable descendants.
   */
  function _getFocusableElements(modalElement) {
    return Array.from(modalElement.querySelectorAll(MODAL_FOCUSABLE_SELECTOR));
  }

  /**
   * Shows modal details for an event using scheduler quick-info templates.
   * @param {Object} event - Event to render in modal.
   * @param {Object} scheduler - Scheduler API object.
   * @param {Object} specification - Calendar specification object.
   * @returns {void} Nothing.
   */
  function _showEventModal(event, scheduler, specification) {
    if (!state.modal.root) {
      return;
    }
    const start = event.start_date;
    const end = event.end_date;
    const templates = scheduler.templates || {};

    state.modal.title.innerHTML =
      typeof templates.quick_info_title === "function"
        ? templates.quick_info_title(start, end, event)
        : "";
    state.modal.date.innerHTML =
      typeof templates.quick_info_date === "function"
        ? templates.quick_info_date(start, end, event)
        : "";
    state.modal.content.innerHTML =
      typeof templates.quick_info_content === "function"
        ? templates.quick_info_content(start, end, event)
        : "";
    state.modal.link.innerHTML = "";

    if (event.url) {
      const link = document.createElement("a");
      link.href = event.url;
      link.target = specification?.target || "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = event.url;
      state.modal.link.appendChild(link);
    }

    state.lastFocusedElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    state.modal.root.classList.add(MOBILE_MODAL_OPEN_CLASS);
    state.modal.root.setAttribute("aria-hidden", "false");

    const focusable = _getFocusableElements(state.modal.root);
    const firstFocusable =
      focusable[0] || state.modal.close || state.modal.root;
    if (firstFocusable && typeof firstFocusable.focus === "function") {
      firstFocusable.focus();
    }
  }

  /**
   * Hides the event details modal and restores previous focus.
   * @returns {void} Nothing.
   */
  function _hideEventModal() {
    if (!state.modal.root) {
      return;
    }
    state.modal.root.classList.remove(MOBILE_MODAL_OPEN_CLASS);
    state.modal.root.setAttribute("aria-hidden", "true");

    if (
      state.lastFocusedElement &&
      typeof state.lastFocusedElement.focus === "function"
    ) {
      state.lastFocusedElement.focus();
    }
    state.lastFocusedElement = null;
  }

  /**
   * Builds a YYYY-MM-DD day key from a Date.
   * @param {Date} date - Date to format.
   * @returns {string} Day key (e.g. "2026-05-15").
   */
  function _dayKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  /**
   * Returns true when a scheduler event spans more than one calendar day.
   * Uses event data (start_date / end_date) instead of rendered geometry so the
   * answer is robust regardless of unit (px / %) used by dhtmlx.
   * @param {Object} event - dhtmlx event object.
   * @returns {boolean} True when start and end fall on different calendar days.
   */
  function _isMultiDayEvent(event) {
    if (!event || !event.start_date || !event.end_date) return false;
    // dhtmlx end_date is exclusive (midnight of next day for all-day). Back off 1ms
    // so the day-key compare lines up with the visually last day of the event.
    const startKey = _dayKey(event.start_date);
    const endAdjusted = new Date(event.end_date.getTime() - 1);
    const endKey = _dayKey(endAdjusted);
    return startKey !== endKey;
  }

  /**
   * Scans the rendered native scheduler view (week/day) for events that share a day
   * COLUMN and replaces them with a single "{N} events" cluster badge per column.
   *
   * Threshold: a cluster is created when 2+ events fall in the same column.
   * Multi-day events are skipped (left visible) — they span days and aren't really
   * "overlapping" in the same column sense.
   *
   * Bucketing uses `getBoundingClientRect().left` (viewport pixels) which works
   * regardless of whether dhtmlx writes inline `left` in `%` or `px`.
   *
   * Idempotent — removes prior cluster badges and unhides events before re-running.
   * @returns {void} Nothing.
   */
  function _clusterWeekViewEvents() {
    if (!state.scheduler) return;
    const tab = state.specification?.tab;
    if (tab !== "week" && tab !== "day") return;

    // Reset prior clustering FIRST so visible events can be measured below.
    document
      .querySelectorAll(".owc-mobile-week-cluster")
      .forEach(function (badge) {
        badge.remove();
      });
    document
      .querySelectorAll(".owc-event-clustered")
      .forEach(function (eventEl) {
        eventEl.classList.remove("owc-event-clustered");
        eventEl.style.display = "";
      });

    const eventNodes = document.querySelectorAll(
      "#scheduler_here .dhx_cal_event, #scheduler_here .dhx_cal_event_line"
    );
    if (!eventNodes.length) return;

    // Pixel tolerance for "same column": dhtmlx may set fractional positions due to
    // sub-pixel rendering. 6px is comfortably below a single column's width on
    // mobile (column ~= 50px+) so distinct columns won't collide.
    const COLUMN_TOLERANCE_PX = 6;

    // First pass: collect candidates with their geometry + event objects.
    const candidates = [];
    eventNodes.forEach(function (eventEl) {
      const id =
        eventEl.getAttribute("event_id") ||
        eventEl.dataset?.eventId ||
        null;
      if (!id) return;
      let event;
      try {
        event = state.scheduler.getEvent(id);
      } catch (err) {
        console.warn("OwcMobileView: getEvent failed", err);
        return;
      }
      if (!event || !event.start_date) return;
      // Multi-day events span multiple visual columns (one wide bar) — leave alone
      if (_isMultiDayEvent(event)) return;

      const rect = eventEl.getBoundingClientRect();
      // Skip nodes that aren't actually rendered (display:none, detached, etc.)
      if (rect.width === 0 && rect.height === 0) return;

      candidates.push({ el: eventEl, event: event, rect: rect });
    });
    if (!candidates.length) return;

    // Second pass: bucket by rounded viewport-x position. Same column = same bucket.
    const groups = new Map();
    candidates.forEach(function (c) {
      const colKey = Math.round(c.rect.left / COLUMN_TOLERANCE_PX);
      if (!groups.has(colKey)) groups.set(colKey, []);
      groups.get(colKey).push(c);
    });

    groups.forEach(function (members) {
      if (members.length < 2) return;

      // Pick the first member as the "anchor" for badge placement; it's already
      // visible so its offsetLeft is meaningful in the parent's coordinate system.
      const anchor = members[0];
      const parent = anchor.el.parentNode;
      if (!parent) return;

      // Capture geometry BEFORE hiding — offsetLeft/offsetWidth return 0 once
      // display:none is applied.
      const anchorOffsetLeft = anchor.el.offsetLeft;
      const anchorOffsetTop = anchor.el.offsetTop;
      const anchorOffsetWidth = anchor.el.offsetWidth;

      // Hide ALL events in the cluster — the badge replaces them entirely. This
      // matches the user's request: a column of overlapping events becomes a single
      // "{N} events" pill that opens the day list.
      members.forEach(function (m) {
        m.el.classList.add("owc-event-clustered");
        m.el.style.display = "none";
      });

      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "owc-mobile-week-cluster";
      badge.dataset.owcAction = "open-day-list";
      badge.dataset.owcDate = _dayKey(anchor.event.start_date);
      badge.textContent = `${members.length} events`;
      // Inline pixel positioning + width lands the badge over the anchor's column
      // regardless of whether dhtmlx wrote `left`/`width` in % or px. Width-matching
      // is what keeps the pill inside its column (no bleed into the next day).
      badge.style.left = `${anchorOffsetLeft}px`;
      badge.style.top = `${anchorOffsetTop}px`;
      if (anchorOffsetWidth > 0) {
        badge.style.width = `${anchorOffsetWidth}px`;
      }
      parent.appendChild(badge);
    });
  }

  /**
   * Wrapper that disconnects the MutationObserver, runs the cluster pass, and then
   * re-attaches the observer. Prevents the observer from spinning on its own
   * mutations (badge insert, display:none toggles).
   * @returns {void} Nothing.
   */
  function _runClustering() {
    if (state.listeners.clusterObserver) {
      state.listeners.clusterObserver.disconnect();
    }
    try {
      _clusterWeekViewEvents();
    } catch (err) {
      console.warn("OwcMobileView: clustering failed", err);
    }
    const target = document.getElementById("scheduler_here");
    if (state.listeners.clusterObserver && target) {
      state.listeners.clusterObserver.observe(target, {
        childList: true,
        subtree: true,
      });
    }
  }

  /**
   * Shows a day-list modal containing all events for the given date.
   * Used when the user clicks a week-view cluster (+N events) badge.
   * @param {Date} dayDate - Day whose events should be listed.
   * @returns {void} Nothing.
   */
  function _showDayListModal(dayDate) {
    if (!state.listModal.root || !state.scheduler) {
      return;
    }
    const localeDate = state.scheduler.locale?.date || {};
    const monthNames = Array.isArray(localeDate.month_full)
      ? localeDate.month_full
      : [];
    const monthName = monthNames[dayDate.getMonth()] || "";
    state.listModal.title.textContent = `${monthName} ${dayDate.getDate()}`.trim();

    state.listModal.content.innerHTML = "";
    const events = _getDayEvents(dayDate);
    if (!events.length) {
      const empty = document.createElement("div");
      empty.className = "owc-mobile-empty-state";
      empty.textContent = state.scheduler.locale?.labels?.no_events || "\u2014";
      state.listModal.content.appendChild(empty);
    } else {
      const list = document.createElement("div");
      list.className = "owc-mobile-day-list";
      events.forEach(function (event, index) {
        const key = `list:${event.id || index}:${event.start_date?.getTime?.() || index}:${index}`;
        state.eventMap.set(key, event);

        const row = document.createElement("button");
        row.type = "button";
        row.className = "owc-mobile-day-list-item";
        row.dataset.owcAction = "open-event";
        row.dataset.owcEventKey = key;

        const cssClasses = Array.isArray(event["css-classes"])
          ? event["css-classes"]
          : [];
        cssClasses.forEach(function (className) {
          if (typeof className === "string" && className.trim()) {
            row.classList.add(className);
          }
        });

        const time = document.createElement("span");
        time.className = "owc-mobile-event-time";
        time.textContent = _formatEventTime(event, state.scheduler, state.specification);
        row.appendChild(time);

        const summary = document.createElement("span");
        summary.className = "owc-mobile-event-summary";
        summary.textContent = event.text || "";
        row.appendChild(summary);

        list.appendChild(row);
      });
      state.listModal.content.appendChild(list);
    }

    state.listModal.root.classList.add(MOBILE_MODAL_OPEN_CLASS);
    state.listModal.root.setAttribute("aria-hidden", "false");
    state.listModal.root.style.display = "";
  }

  /**
   * Hides the day-list modal.
   * @returns {void} Nothing.
   */
  function _hideDayListModal() {
    if (!state.listModal.root) {
      return;
    }
    state.listModal.root.classList.remove(MOBILE_MODAL_OPEN_CLASS);
    state.listModal.root.setAttribute("aria-hidden", "true");
  }

  /**
   * Rebuilds the mobile shell content for current state.
   * @returns {void} Nothing.
   */
  function _render() {
    if (!state.initialized || !state.root || !state.calendarContainer) {
      return;
    }

    const mobile = _isMobile(state.specification);
    const currentTab = state.specification?.tab || "month";
    const useMobileShell = mobile && currentTab === "month";
    document.body.classList.toggle(MOBILE_VIEWPORT_CLASS, mobile);
    document.body.classList.toggle(MOBILE_VIEW_CLASS, useMobileShell);
    state.root.setAttribute("aria-hidden", useMobileShell ? "false" : "true");

    if (!useMobileShell) {
      _hideEventModal();
      return;
    }

    if (!state.selectedDate) {
      state.selectedDate = _startOfDay(new Date());
    }
    if (!state.viewMonth) {
      state.viewMonth = state.scheduler.date.month_start(new Date(state.selectedDate));
    }

    state.calendarContainer.innerHTML = "";
    state.calendarContainer.appendChild(
      _renderMiniMonth(state.viewMonth, state.scheduler, state.specification)
    );
    state.calendarContainer.appendChild(
      _renderDayList(state.selectedDate, state.scheduler, state.specification)
    );
  }

  /**
   * Applies mobile action changes based on delegated click events.
   * @param {HTMLElement} actionElement - Element carrying action data.
   * @returns {void} Nothing.
   */
  function _handleAction(actionElement) {
    const action = actionElement.dataset.owcAction;
    if (!action) {
      return;
    }

    if (action === "prev-month") {
      state.viewMonth = state.scheduler.date.month_start(
        state.scheduler.date.add(state.viewMonth, -1, "month")
      );
      state.scheduler.setCurrentView(state.viewMonth, "month");
      _render();
      return;
    }

    if (action === "next-month") {
      state.viewMonth = state.scheduler.date.month_start(
        state.scheduler.date.add(state.viewMonth, 1, "month")
      );
      state.scheduler.setCurrentView(state.viewMonth, "month");
      _render();
      return;
    }

    if (action === "today") {
      const today = _startOfDay(new Date());
      state.selectedDate = today;
      state.viewMonth = state.scheduler.date.month_start(new Date(today));
      state.scheduler.setCurrentView(today, "month");
      _render();
      return;
    }

    if (action === "select-day") {
      const day = _parseDateKey(actionElement.dataset.owcDate || "");
      if (!day) {
        return;
      }
      state.selectedDate = _startOfDay(day);
      state.viewMonth = state.scheduler.date.month_start(new Date(day));
      state.scheduler.setCurrentView(day, "month");
      _render();
      return;
    }

    if (action === "open-event") {
      const eventKey = actionElement.dataset.owcEventKey || "";
      const event = state.eventMap.get(eventKey);
      if (!event) {
        return;
      }
      // Hide the day-list modal first if it was the source — otherwise the event
      // modal would render behind it
      _hideDayListModal();
      _showEventModal(event, state.scheduler, state.specification);
      return;
    }

    if (action === "open-day-list") {
      const dayDate = _parseDateKey(actionElement.dataset.owcDate || "");
      if (!dayDate) {
        return;
      }
      _showDayListModal(dayDate);
      return;
    }

    if (action === "close-modal") {
      _hideEventModal();
    }
  }

  /**
   * Binds delegated click and keyboard handlers once.
   * @param {HTMLElement} root - Mobile shell root element.
   * @returns {void} Nothing.
   */
  function _attachClickHandlers(root) {
    if (state.listeners.click) {
      document.removeEventListener("click", state.listeners.click);
    }
    if (state.listeners.modalClick && state.modal.root) {
      state.modal.root.removeEventListener("click", state.listeners.modalClick);
    }
    if (state.listeners.listModalClick && state.listModal.root) {
      state.listModal.root.removeEventListener(
        "click",
        state.listeners.listModalClick
      );
    }
    if (state.listeners.keydown) {
      document.removeEventListener("keydown", state.listeners.keydown);
    }

    // Event-modal close/backdrop handler — bound to the modal element
    state.listeners.modalClick = function onModalClick(event) {
      const closeTarget = event.target.closest(
        ".owc-mobile-modal-close, .owc-mobile-modal-backdrop"
      );
      if (closeTarget) {
        _hideEventModal();
      }
    };

    // Day-list-modal close/backdrop handler — bound to the list modal element
    state.listeners.listModalClick = function onListModalClick(event) {
      const closeTarget = event.target.closest(
        ".owc-mobile-modal-close, .owc-mobile-modal-backdrop"
      );
      if (closeTarget) {
        _hideDayListModal();
      }
    };

    // Action delegation — bound to document so it captures clicks both inside
    // the mobile shell AND on the cluster badges injected into the scheduler DOM
    state.listeners.click = function onDocumentClick(event) {
      const actionElement = event.target.closest("[data-owc-action]");
      if (!actionElement) {
        return;
      }
      _handleAction(actionElement);
    };

    // Keyboard handler — closes whichever modal is open, traps focus inside it
    state.listeners.keydown = function onDocumentKeyDown(event) {
      const eventModalOpen =
        state.modal.root &&
        state.modal.root.classList.contains(MOBILE_MODAL_OPEN_CLASS);
      const listModalOpen =
        state.listModal.root &&
        state.listModal.root.classList.contains(MOBILE_MODAL_OPEN_CLASS);
      if (!eventModalOpen && !listModalOpen) {
        return;
      }

      // Prefer event-modal precedence since it can render on top of the list modal
      const activeModal = eventModalOpen ? state.modal.root : state.listModal.root;

      if (event.key === "Escape") {
        event.preventDefault();
        if (eventModalOpen) {
          _hideEventModal();
        } else {
          _hideDayListModal();
        }
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusable = _getFocusableElements(activeModal);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;

      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("click", state.listeners.click);
    if (state.modal.root) {
      state.modal.root.addEventListener("click", state.listeners.modalClick);
    }
    if (state.listModal.root) {
      state.listModal.root.addEventListener(
        "click",
        state.listeners.listModalClick
      );
    }
    document.addEventListener("keydown", state.listeners.keydown);
  }

  /**
   * Attaches debounced viewport listeners for responsive rerender.
   * @param {Object} scheduler - Scheduler API object.
   * @param {Object} specification - Calendar specification object.
   * @returns {void} Nothing.
   */
  function _observeViewport(scheduler, specification) {
    if (state.listeners.resize) {
      window.removeEventListener("resize", state.listeners.resize);
      window.removeEventListener("orientationchange", state.listeners.resize);
    }

    state.listeners.resize = _debounce(function onViewportChange() {
      state.scheduler = scheduler;
      state.specification = specification;
      _render();
    }, 150);

    window.addEventListener("resize", state.listeners.resize);
    window.addEventListener("orientationchange", state.listeners.resize);
  }

  /**
   * Initializes the mobile shell and binds handlers idempotently.
   * @param {Object} scheduler - Scheduler API object.
   * @param {Object} specification - Calendar specification object. 
   * @returns {void} Nothing.
   */
  function init(scheduler, specification) {
    if (!scheduler || !specification) {
      return;
    }

    if (state.initialized && state.scheduler === scheduler && state.root) {
      state.specification = specification;
      _render();
      return;
    }

    if (state.initialized) {
      destroy();
    }

    const root = document.getElementById("owc-mobile-shell");
    if (!root) {
      return;
    }

    // Scope event-modal queries to the event modal element so we don't accidentally
    // grab elements from the list modal (which shares some class names)
    const modalRoot = document.querySelector(".owc-mobile-event-modal");
    const modalClose = modalRoot
      ? modalRoot.querySelector(".owc-mobile-modal-close")
      : null;
    const modalTitle = modalRoot
      ? modalRoot.querySelector(".owc-mobile-modal-title")
      : null;
    const modalDate = modalRoot
      ? modalRoot.querySelector(".owc-mobile-modal-date")
      : null;
    const modalContent = modalRoot
      ? modalRoot.querySelector(".owc-mobile-modal-content")
      : null;
    const modalLink = modalRoot
      ? modalRoot.querySelector(".owc-mobile-modal-link")
      : null;

    // Day-list modal lookup (separate dialog used for week-view cluster click)
    const listModalRoot = document.querySelector(".owc-mobile-event-list-modal");
    const listModalTitle = listModalRoot
      ? listModalRoot.querySelector(".owc-mobile-list-modal-title")
      : null;
    const listModalContent = listModalRoot
      ? listModalRoot.querySelector(".owc-mobile-list-modal-content")
      : null;

    const calendarContainer = document.createElement("div");
    calendarContainer.className = "owc-mobile-calendar";

    root.appendChild(calendarContainer);
    if (modalRoot) {
      modalRoot.removeAttribute("style");
    }
    if (listModalRoot) {
      listModalRoot.removeAttribute("style");
    }

    const currentDate = scheduler.getState?.().date || new Date();
    state.initialized = true;
    state.scheduler = scheduler;
    state.specification = specification;
    state.root = root;
    state.calendarContainer = calendarContainer;
    state.modal.root = modalRoot;
    state.modal.close = modalClose;
    state.modal.title = modalTitle;
    state.modal.date = modalDate;
    state.modal.content = modalContent;
    state.modal.link = modalLink;
    state.listModal.root = listModalRoot;
    state.listModal.title = listModalTitle;
    state.listModal.content = listModalContent;
    state.selectedDate = _startOfDay(new Date(currentDate));
    state.viewMonth = scheduler.date.month_start(new Date(state.selectedDate));

    _attachClickHandlers(root);
    _observeViewport(scheduler, specification);
    if (state.listeners.onClickId) {
      scheduler.detachEvent(state.listeners.onClickId);
    }
    state.listeners.onClickId = scheduler.attachEvent("onClick", function (id) {
      if (!_isMobile(state.specification)) return true;
      const event = scheduler.getEvent(id);
      if (event) {
        _showEventModal(event, state.scheduler, state.specification);
      }
      // Suppress quick-info popup that the plugin may show independently
      if (typeof scheduler.hideQuickInfo === "function") {
        scheduler.hideQuickInfo();
      }
      return false;
    });

    // Re-cluster events after each load (onXLE fires on initial load and per nav)
    // and after every view change. Run once on next tick to ensure events render first.
    if (state.listeners.onXleId) {
      scheduler.detachEvent(state.listeners.onXleId);
    }
    state.listeners.onXleId = scheduler.attachEvent("onXLE", function () {
      if (!_isMobile(state.specification)) return;
      setTimeout(_runClustering, 0);
    });
    if (state.listeners.onViewChangeId) {
      scheduler.detachEvent(state.listeners.onViewChangeId);
    }
    state.listeners.onViewChangeId = scheduler.attachEvent(
      "onViewChange",
      function () {
        if (!_isMobile(state.specification)) return;
        setTimeout(_runClustering, 0);
      }
    );

    // MutationObserver re-runs clustering whenever dhtmlx mutates the scheduler DOM
    // (week navigation, scroll, internal re-renders). dhtmlx exposes no clean
    // "after render" hook so the observer is the most reliable trigger. Debounced
    // to coalesce the burst of mutations that fire during a single render pass.
    if (state.listeners.clusterObserver) {
      state.listeners.clusterObserver.disconnect();
    }
    state.listeners.clusterObserver = new MutationObserver(function () {
      if (!_isMobile(state.specification)) return;
      const tab = state.specification?.tab;
      if (tab !== "week" && tab !== "day") return;
      if (state.listeners.clusterDebounceId) {
        clearTimeout(state.listeners.clusterDebounceId);
      }
      state.listeners.clusterDebounceId = setTimeout(_runClustering, 60);
    });
    const observerTarget = document.getElementById("scheduler_here");
    if (observerTarget) {
      state.listeners.clusterObserver.observe(observerTarget, {
        childList: true,
        subtree: true,
      });
    }

    _render();
  }

  /**
   * Refreshes mobile shell from current scheduler state.
   * @returns {void} Nothing.
   */
  function refresh() {
    if (!state.initialized) {
      return;
    }
    _render();
  }

  /**
   * Tears down handlers and removes mobile shell runtime state.
   * @returns {void} Nothing.
   */
  function destroy() {
    if (!state.initialized) {
      return;
    }

    // Click delegation is now bound to document (not state.root) because cluster
    // badges live in the scheduler DOM
    if (state.listeners.click) {
      document.removeEventListener("click", state.listeners.click);
    }
    if (state.modal.root && state.listeners.modalClick) {
      state.modal.root.removeEventListener("click", state.listeners.modalClick);
    }
    if (state.listModal.root && state.listeners.listModalClick) {
      state.listModal.root.removeEventListener(
        "click",
        state.listeners.listModalClick
      );
    }
    if (state.listeners.keydown) {
      document.removeEventListener("keydown", state.listeners.keydown);
    }
    if (state.listeners.resize) {
      window.removeEventListener("resize", state.listeners.resize);
      window.removeEventListener("orientationchange", state.listeners.resize);
    }
    if (state.listeners.onClickId && state.scheduler) {
      state.scheduler.detachEvent(state.listeners.onClickId);
    }
    if (state.listeners.onXleId && state.scheduler) {
      state.scheduler.detachEvent(state.listeners.onXleId);
    }
    if (state.listeners.onViewChangeId && state.scheduler) {
      state.scheduler.detachEvent(state.listeners.onViewChangeId);
    }
    if (state.listeners.clusterObserver) {
      state.listeners.clusterObserver.disconnect();
    }
    if (state.listeners.clusterDebounceId) {
      clearTimeout(state.listeners.clusterDebounceId);
    }

    _hideEventModal();
    _hideDayListModal();
    // Clean up stale cluster badges and unhide any clustered events so the
    // desktop scheduler renders correctly if the user resizes mobile -> desktop
    document
      .querySelectorAll(".owc-mobile-week-cluster")
      .forEach(function (badge) {
        badge.remove();
      });
    // Use the marker class directly so this also unhides .dhx_cal_event_line nodes
    document
      .querySelectorAll(".owc-event-clustered")
      .forEach(function (eventEl) {
        eventEl.classList.remove("owc-event-clustered");
        eventEl.style.display = "";
      });
    document.body.classList.remove(MOBILE_VIEW_CLASS);
    document.body.classList.remove(MOBILE_VIEWPORT_CLASS);
    if (state.root) {
      state.root.setAttribute("aria-hidden", "true");
    }
    if (state.calendarContainer && state.calendarContainer.parentNode) {
      state.calendarContainer.parentNode.removeChild(state.calendarContainer);
    }

    state.initialized = false;
    state.scheduler = null;
    state.specification = null;
    state.root = null;
    state.calendarContainer = null;
    state.modal.root = null;
    state.modal.close = null;
    state.modal.title = null;
    state.modal.date = null;
    state.modal.content = null;
    state.modal.link = null;
    state.listModal.root = null;
    state.listModal.title = null;
    state.listModal.content = null;
    state.selectedDate = null;
    state.viewMonth = null;
    state.eventMap.clear();
    state.lastFocusedElement = null;
    state.listeners.click = null;
    state.listeners.modalClick = null;
    state.listeners.listModalClick = null;
    state.listeners.keydown = null;
    state.listeners.resize = null;
    state.listeners.onClickId = null;
    state.listeners.onXleId = null;
    state.listeners.onViewChangeId = null;
    state.listeners.clusterObserver = null;
    state.listeners.clusterDebounceId = null;
  }

  window.OwcMobileView = {
    init,
    refresh,
    destroy,
  };
})();

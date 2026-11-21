/* ============================================================
   script.js  —  Student Exam Scores Dashboard
   
   Architecture:
     1. CSV_PATH       – path to the data file
     2. parseCSV()     – fetch + PapaParse wrapper
     3. Alpine.data()  – registers the "dashboard" Alpine component
        - state          reactive data properties
        - init()         loads CSV, runs first render
        - computed props filtered, statCards, tableRows, totalPages
        - filter / sort  watchers that re-render charts on change
        - charts         Chart.js instances, created / updated lazily
   ============================================================ */

'use strict';

/* ── Path to CSV (same directory as index.html) ─────────────── */
const CSV_PATH = 'student_exam_scores_dataset.csv';

/* ── Pastel colour palette shared by all charts ─────────────── */
const PALETTE = {
  indigo:  'rgba(99,102,241,.75)',
  pink:    'rgba(236,72,153,.75)',
  teal:    'rgba(20,184,166,.75)',
  amber:   'rgba(245,158,11,.75)',
  rose:    'rgba(244,63,94,.75)',
  purple:  'rgba(168,85,247,.75)',
  sky:     'rgba(14,165,233,.75)',
  lime:    'rgba(132,204,22,.75)',
  border:  {
    indigo:  'rgba(99,102,241,1)',
    pink:    'rgba(236,72,153,1)',
    teal:    'rgba(20,184,166,1)',
    amber:   'rgba(245,158,11,1)',
    rose:    'rgba(244,63,94,1)',
    purple:  'rgba(168,85,247,1)',
    sky:     'rgba(14,165,233,1)',
    lime:    'rgba(132,204,22,1)',
  },
};

/* ── Default Chart.js global settings ───────────────────────── */
Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
Chart.defaults.font.size   = 11;
Chart.defaults.color       = '#94a3b8';
Chart.defaults.plugins.legend.labels.boxWidth = 10;
Chart.defaults.plugins.legend.labels.padding  = 12;

/* ════════════════════════════════════════════════════════════
   parseCSV(path)
   Fetches the CSV file and uses PapaParse to convert it into
   an array of objects. Returns a Promise<Array<Object>>.
   ════════════════════════════════════════════════════════════ */
async function parseCSV(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Cannot load "${path}" (HTTP ${response.status}). Make sure you are serving the files from a web server, not opening index.html directly as file://.`);
  }
  const text = await response.text();

  return new Promise((resolve, reject) => {
    Papa.parse(text, {
      header: true,          // first row becomes object keys
      skipEmptyLines: true,
      dynamicTyping: true,   // auto-convert numbers
      complete: (result) => resolve(result.data),
      error: (err)       => reject(err),
    });
  });
}

/* ════════════════════════════════════════════════════════════
   Utility helpers
   ════════════════════════════════════════════════════════════ */

/** Average of an array of numbers */
const avg = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

/** Round to one decimal */
const r1 = (n) => Math.round(n * 10) / 10;

/** Group array by a key, returning { key: [items] } */
const groupBy = (arr, key) =>
  arr.reduce((acc, item) => {
    const k = item[key] ?? 'Unknown';
    (acc[k] = acc[k] || []).push(item);
    return acc;
  }, {});

/** Bucket exam scores into ranges for the histogram */
function scoreHistogram(students) {
  // Buckets: 0-9, 10-19, …, 90-99, 100
  const buckets = Array.from({ length: 11 }, (_, i) => ({
    label: i < 10 ? `${i * 10}–${i * 10 + 9}` : '100',
    count: 0,
  }));
  students.forEach(({ exam_score }) => {
    const idx = exam_score >= 100 ? 10 : Math.floor(exam_score / 10);
    buckets[idx].count++;
  });
  return buckets;
}

/* ════════════════════════════════════════════════════════════
   destroyChart(instance)
   Safely destroy a Chart.js instance before re-creating it,
   preventing "Canvas is already in use" errors on filter change.
   ════════════════════════════════════════════════════════════ */
function destroyChart(instance) {
  if (instance) instance.destroy();
}

/* ════════════════════════════════════════════════════════════
   Alpine.data('dashboard')
   The single reactive component that powers the whole page.
   ════════════════════════════════════════════════════════════ */
document.addEventListener('alpine:init', () => {
  Alpine.data('dashboard', () => ({

    /* ── State ─────────────────────────────────────────── */
    all:     [],       // full dataset (never mutated)
    loading: true,     // show/hide skeleton
    error:   null,     // error message string or null

    /* Filter values (bound to <select> / <input> in HTML) */
    filters: {
      search:    '',
      gender:    '',
      income:    '',
      health:    '',
      parentEdu: '',
    },

    sortBy:   'exam_score_desc',
    page:     1,
    pageSize: 10,

    /* Chart.js instances — stored so we can destroy before update */
    _charts: {},

    /* ── Add Student Modal state ────────────────────────── */
    showModal:   false,
    formLoading: false,
    formSuccess: '',      // student_id string on success, '' otherwise
    formErrors:  [],      // array of error strings from server or client

    /* Blank form template — matches all 15 input fields
       (student_id is auto-generated by the backend) */
    form: {
      age:                      '',
      gender:                   '',
      family_income_level:      '',
      parental_education_level: '',
      attendance_percentage:    '',
      group_study_frequency:    '',
      sports:                   '',
      extracurricular_activities: '',
      volunteering:             '',
      health:                   '',
      previous_semester_score:  '',
      study_hours_per_month:    '',
      library_hours_per_month:  '',
      online_usage_per_month:   '',
      exam_score:               '',
    },

    /* ── Lifecycle ─────────────────────────────────────── */

    /**
     * init() is called by Alpine x-init on the root element.
     * Loads CSV, populates `all`, then triggers first render.
     */
    async init() {
      try {
        this.all = await parseCSV(CSV_PATH);
      } catch (e) {
        this.error   = e.message;
        this.loading = false;
        return;
      }
      this.loading = false;

      // x-show (not x-if) keeps canvases in the DOM from the start.
      // A short setTimeout ensures the browser has painted the newly
      // visible elements before Chart.js measures their dimensions.
      setTimeout(() => this._renderCharts(), 60);

      // Re-render charts whenever a filter or sort value changes.
      const watchTargets = [
        'filters.search', 'filters.gender', 'filters.income',
        'filters.health', 'filters.parentEdu', 'sortBy',
      ];
      watchTargets.forEach((key) =>
        this.$watch(key, () => {
          this.page = 1;
          this.$nextTick(() => this._renderCharts());
        })
      );
      // Reset page when page size changes (charts don't need re-render here)
      this.$watch('pageSize', () => { this.page = 1; });
    },

    /* ── Computed: filtered & sorted student list ───────── */

    /**
     * `filtered` returns a NEW sorted array derived from `all`
     * based on current filter values.
     * Alpine evaluates this getter whenever any reactive
     * dependency changes (all filters, sortBy).
     */
    get filtered() {
      const { search, gender, income, health, parentEdu } = this.filters;
      const q = search.trim().toUpperCase();

      let result = this.all.filter((s) => {
        if (q       && !String(s.student_id).toUpperCase().includes(q)) return false;
        if (gender  && s.gender             !== gender)                  return false;
        if (income  && s.family_income_level !== income)                  return false;
        if (health  && s.health              !== health)                  return false;
        if (parentEdu && s.parental_education_level !== parentEdu)        return false;
        return true;
      });

      // Parse sort key: "exam_score_desc" → sortField="exam_score", sortDir="desc"
      // The option values map shorthand keys to actual CSV column names.
      const SORT_FIELD_MAP = {
        'exam_score':   'exam_score',
        'attendance':   'attendance_percentage',
        'study_hours':  'study_hours_per_month',
        'age':          'age',
      };

      const sortParts = this.sortBy.split('_');
      const sortDir   = sortParts.pop();                       // last segment ("asc" or "desc")
      const sortKey   = sortParts.join('_');                   // e.g. "exam_score", "attendance"
      const sortField = SORT_FIELD_MAP[sortKey] ?? sortKey;    // map to actual CSV column name

      result = [...result].sort((a, b) => {
        const av = a[sortField] ?? 0;
        const bv = b[sortField] ?? 0;
        return sortDir === 'asc' ? av - bv : bv - av;
      });

      return result;
    },

    /* ── KPI Stat Cards ─────────────────────────────────── */

    /**
     * statCards builds the six KPI tiles at the top.
     * Re-computed whenever `filtered` changes.
     */
    get statCards() {
      const d = this.filtered;
      if (!d.length) return [];

      const scores  = d.map((s) => s.exam_score);
      const maxS    = Math.max(...scores);
      const minS    = Math.min(...scores);
      const avgS    = r1(avg(scores));
      const pass    = d.filter((s) => s.exam_score >= 50).length;
      const passRate = r1((pass / d.length) * 100);
      const avgAtt  = r1(avg(d.map((s) => s.attendance_percentage)));

      return [
        { label: 'Total Students',    value: d.length,        bg: 'bg-pastelPurple', color: 'text-accent' },
        { label: 'Avg Exam Score',    value: avgS,            bg: 'bg-pastelBlue',   color: 'text-blue-600' },
        { label: 'Highest Score',     value: maxS,            bg: 'bg-pastelGreen',  color: 'text-green-600' },
        { label: 'Lowest Score',      value: minS,            bg: 'bg-pastelPink',   color: 'text-pink-600' },
        { label: 'Pass Rate (≥50)',   value: passRate + '%',  bg: 'bg-pastelYellow', color: 'text-amber-600' },
        { label: 'Avg Attendance %',  value: avgAtt + '%',    bg: 'bg-pastelOrange', color: 'text-orange-500' },
      ];
    },

    /* ── Table pagination ───────────────────────────────── */

    get totalPages() {
      return Math.max(1, Math.ceil(this.filtered.length / this.pageSize));
    },

    get tableRows() {
      const start = (this.page - 1) * this.pageSize;
      return this.filtered.slice(start, start + this.pageSize);
    },

    prevPage() { if (this.page > 1) this.page--; },
    nextPage() { if (this.page < this.totalPages) this.page++; },

    /* ── Filter reset ───────────────────────────────────── */
    resetFilters() {
      this.filters = { search: '', gender: '', income: '', health: '', parentEdu: '' };
      this.sortBy  = 'exam_score_desc';
      this.page    = 1;
    },

    /* ════════════════════════════════════════════════════
       ADD STUDENT MODAL — open / close / submit
       ════════════════════════════════════════════════════ */

    /** Open modal and reset all form state */
    openModal() {
      this.formErrors  = [];
      this.formSuccess = '';
      this.formLoading = false;
      // Reset form to blank values
      Object.keys(this.form).forEach((k) => { this.form[k] = ''; });
      this.showModal = true;
      // Prevent background scroll
      document.body.style.overflow = 'hidden';
    },

    /** Close modal and restore scroll */
    closeModal() {
      this.showModal = false;
      document.body.style.overflow = '';
    },

    /**
     * submitStudent()  —  Opsi A (pure in-memory, no backend)
     * Validates the form client-side, generates a new student_id,
     * appends the record to this.all (live reactive dataset), and
     * re-renders all charts immediately. Data persists for the
     * current browser session. Use exportCSV() to save permanently.
     */
    submitStudent() {
      this.formErrors  = [];
      this.formSuccess = '';

      // ── Validation ────────────────────────────────────
      const errors = [];

      // Required-field check
      const missing = Object.entries(this.form)
        .filter(([, v]) => v === '' || v === null || v === undefined)
        .map(([k]) => k.replace(/_/g, ' '));
      missing.forEach((f) => errors.push(`Field wajib diisi: ${f}`));

      // Numeric range checks (only when value is present)
      const ranges = {
        age:                     [15, 60],
        attendance_percentage:   [0, 100],
        previous_semester_score: [0, 100],
        study_hours_per_month:   [0, 300],
        library_hours_per_month: [0, 200],
        online_usage_per_month:  [0, 300],
        exam_score:              [0, 100],
      };
      Object.entries(ranges).forEach(([field, [lo, hi]]) => {
        const val = Number(this.form[field]);
        if (this.form[field] !== '' && (isNaN(val) || val < lo || val > hi)) {
          errors.push(`${field.replace(/_/g, ' ')} harus antara ${lo} dan ${hi}`);
        }
      });

      if (errors.length) {
        this.formErrors = errors;
        return;
      }

      // ── Generate next student_id ───────────────────────
      // Find the highest existing numeric suffix (e.g. S1501 → 1501)
      const maxNum = this.all.reduce((max, s) => {
        const n = parseInt(String(s.student_id).replace(/\D/g, ''), 10);
        return isNaN(n) ? max : Math.max(max, n);
      }, 999);
      const newId = `S${maxNum + 1}`;

      // ── Build the new record ───────────────────────────
      const newStudent = {
        student_id:               newId,
        age:                      Number(this.form.age),
        gender:                   this.form.gender,
        family_income_level:      this.form.family_income_level,
        parental_education_level: this.form.parental_education_level,
        attendance_percentage:    Number(this.form.attendance_percentage),
        group_study_frequency:    this.form.group_study_frequency,
        sports:                   this.form.sports,
        extracurricular_activities: this.form.extracurricular_activities,
        volunteering:             this.form.volunteering,
        health:                   this.form.health,
        previous_semester_score:  Number(this.form.previous_semester_score),
        study_hours_per_month:    Number(this.form.study_hours_per_month),
        library_hours_per_month:  Number(this.form.library_hours_per_month),
        online_usage_per_month:   Number(this.form.online_usage_per_month),
        exam_score:               Number(this.form.exam_score),
      };

      // ── Append and refresh ─────────────────────────────
      // Alpine detects the new array reference and re-evaluates
      // all computed getters (filtered, statCards, tableRows).
      this.all = [...this.all, newStudent];
      this.$nextTick(() => this._renderCharts());

      this.formSuccess = newId;

      // Auto-close modal after 1.8 s so user can see the success banner
      setTimeout(() => this.closeModal(), 1800);
    },

    /* ════════════════════════════════════════════════════
       EXPORT CSV
       Builds a CSV string from this.all (includes any
       newly added rows from this session) and triggers a
       browser download.
       ════════════════════════════════════════════════════ */
    exportCSV() {
      const cols = [
        'student_id', 'age', 'gender', 'family_income_level',
        'parental_education_level', 'attendance_percentage',
        'group_study_frequency', 'sports', 'extracurricular_activities',
        'volunteering', 'health', 'previous_semester_score',
        'study_hours_per_month', 'library_hours_per_month',
        'online_usage_per_month', 'exam_score',
      ];

      // Header row
      const lines = [cols.join(',')];

      // Data rows — wrap any value that contains a comma in quotes
      this.all.forEach((s) => {
        const row = cols.map((c) => {
          const v = String(s[c] ?? '');
          return v.includes(',') ? `"${v}"` : v;
        });
        lines.push(row.join(','));
      });

      const csv  = lines.join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url  = URL.createObjectURL(blob);

      // Trigger download
      const a    = document.createElement('a');
      a.href     = url;
      a.download = 'student_exam_scores_dataset.csv';
      a.click();
      URL.revokeObjectURL(url);
    },

    /* ── Badge helpers (called from HTML :class bindings) ── */

    healthBadge(health) {
      const map = {
        Excellent: 'badge-excellent',
        Good:      'badge-good',
        Fair:      'badge-fair',
        Poor:      'badge-poor',
      };
      return map[health] || 'badge-fair';
    },

    scoreBadge(score) {
      if (score >= 70) return 'score-high';
      if (score >= 40) return 'score-mid';
      return 'score-low';
    },

    /* ════════════════════════════════════════════════════
       CHART RENDERING
       _renderCharts() is called once after init() and
       again after every filter change (via $nextTick).
       ════════════════════════════════════════════════════ */
    _renderCharts() {
      const d = this.filtered;

      this._chartScoreDist(d);
      this._chartGender(d);
      this._chartAttendance(d);
      this._chartStudy(d);
      this._chartIncome(d);
      this._chartHealth(d);
      this._chartParentEdu(d);
    },

    /* ─── Helper: safely create/recreate a Chart.js instance ─ */
    _makeChart(id, config) {
      // Destroy previous instance to prevent "canvas already in use" error
      destroyChart(this._charts[id]);
      const canvas = document.getElementById(id);
      if (!canvas) { console.warn(`Canvas #${id} not found`); return; }
      this._charts[id] = new Chart(canvas, config);
    },

    /* ─── Chart 1: Exam Score Distribution (histogram) ───── */
    _chartScoreDist(students) {
      const buckets = scoreHistogram(students);
      this._makeChart('chartScoreDist', {
        type: 'bar',
        data: {
          labels:   buckets.map((b) => b.label),
          datasets: [{
            label:           'Students',
            data:            buckets.map((b) => b.count),
            backgroundColor: 'rgba(99,102,241,0.75)',
            borderColor:     'rgba(99,102,241,1)',
            borderWidth:     1,
            borderRadius:    5,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: false },
            // Show count value on top of each bar
            datalabels: false,
            tooltip: {
              callbacks: { label: (ctx) => ` ${ctx.parsed.y} students` },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              title: { display: true, text: 'Score Range', color: '#94a3b8' },
              ticks: { color: '#64748b' },
            },
            y: {
              grid: { color: '#f1f5f9' },
              title: { display: true, text: 'Number of Students', color: '#94a3b8' },
              beginAtZero: true,
              ticks: { color: '#64748b', stepSize: 20 },
            },
          },
        },
      });
    },

    /* ─── Chart 2: Score by Gender (grouped bar) ─────────── */
    _chartGender(students) {
      // Count students and avg score per gender
      const groups  = groupBy(students, 'gender');
      const genders = ['Male', 'Female'].filter((g) => groups[g]);
      const counts  = genders.map((g) => groups[g].length);
      const avgs    = genders.map((g) => r1(avg(groups[g].map((s) => s.exam_score))));

      this._makeChart('chartGender', {
        type: 'bar',
        data: {
          labels: genders,
          datasets: [
            {
              label:           'Avg Exam Score',
              data:            avgs,
              backgroundColor: ['rgba(14,165,233,0.75)', 'rgba(236,72,153,0.75)'],
              borderColor:     ['rgba(14,165,233,1)',     'rgba(236,72,153,1)'],
              borderWidth:     1,
              borderRadius:    6,
              yAxisID:         'yScore',
            },
            {
              label:           'Student Count',
              data:            counts,
              backgroundColor: ['rgba(14,165,233,0.2)', 'rgba(236,72,153,0.2)'],
              borderColor:     ['rgba(14,165,233,0.5)', 'rgba(236,72,153,0.5)'],
              borderWidth:     1,
              borderRadius:    6,
              yAxisID:         'yCount',
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { position: 'bottom', labels: { color: '#64748b', boxWidth: 10, padding: 10 } },
            tooltip: { mode: 'index', intersect: false },
          },
          scales: {
            x:      { grid: { display: false }, ticks: { color: '#64748b' } },
            yScore: {
              position: 'left',
              min: 0, max: 100,
              grid: { color: '#f1f5f9' },
              title: { display: true, text: 'Avg Score', color: '#94a3b8' },
              ticks: { color: '#64748b' },
            },
            yCount: {
              position: 'right',
              beginAtZero: true,
              grid: { drawOnChartArea: false },
              title: { display: true, text: 'Count', color: '#94a3b8' },
              ticks: { color: '#64748b' },
            },
          },
        },
      });
    },

    /* ─── Chart 3: Attendance % vs Exam Score (scatter) ──── */
    _chartAttendance(students) {
      // Use all points — scatter handles 1500 easily
      const female = students.filter((s) => s.gender === 'Female')
        .map((s) => ({ x: s.attendance_percentage, y: s.exam_score }));
      const male   = students.filter((s) => s.gender === 'Male')
        .map((s) => ({ x: s.attendance_percentage, y: s.exam_score }));

      this._makeChart('chartAttendance', {
        type: 'scatter',
        data: {
          datasets: [
            {
              label:            'Female',
              data:             female,
              backgroundColor:  'rgba(236,72,153,0.5)',
              pointRadius:      3,
              pointHoverRadius: 5,
            },
            {
              label:            'Male',
              data:             male,
              backgroundColor:  'rgba(14,165,233,0.5)',
              pointRadius:      3,
              pointHoverRadius: 5,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { position: 'bottom', labels: { color: '#64748b', boxWidth: 10, padding: 10 } },
            tooltip: {
              callbacks: {
                label: (ctx) => ` Att: ${ctx.parsed.x}%  Score: ${ctx.parsed.y}`,
              },
            },
          },
          scales: {
            x: {
              grid: { color: '#f1f5f9' },
              title: { display: true, text: 'Attendance (%)', color: '#94a3b8' },
              min: 40, max: 100,
              ticks: { color: '#64748b' },
            },
            y: {
              grid: { color: '#f1f5f9' },
              title: { display: true, text: 'Exam Score', color: '#94a3b8' },
              min: 0, max: 100,
              ticks: { color: '#64748b' },
            },
          },
        },
      });
    },

    /* ─── Chart 4: Study Hours vs Exam Score (scatter) ───── */
    _chartStudy(students) {
      const female = students.filter((s) => s.gender === 'Female')
        .map((s) => ({ x: s.study_hours_per_month, y: s.exam_score }));
      const male   = students.filter((s) => s.gender === 'Male')
        .map((s) => ({ x: s.study_hours_per_month, y: s.exam_score }));

      this._makeChart('chartStudy', {
        type: 'scatter',
        data: {
          datasets: [
            {
              label:            'Female',
              data:             female,
              backgroundColor:  'rgba(245,158,11,0.5)',
              pointRadius:      3,
              pointHoverRadius: 5,
            },
            {
              label:            'Male',
              data:             male,
              backgroundColor:  'rgba(168,85,247,0.5)',
              pointRadius:      3,
              pointHoverRadius: 5,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { position: 'bottom', labels: { color: '#64748b', boxWidth: 10, padding: 10 } },
            tooltip: {
              callbacks: {
                label: (ctx) => ` Study: ${ctx.parsed.x}h  Score: ${ctx.parsed.y}`,
              },
            },
          },
          scales: {
            x: {
              grid: { color: '#f1f5f9' },
              title: { display: true, text: 'Study Hours / Month', color: '#94a3b8' },
              beginAtZero: true,
              ticks: { color: '#64748b' },
            },
            y: {
              grid: { color: '#f1f5f9' },
              title: { display: true, text: 'Exam Score', color: '#94a3b8' },
              min: 0, max: 100,
              ticks: { color: '#64748b' },
            },
          },
        },
      });
    },

    /* ─── Chart 5: Avg Score by Income Level (horizontal bar) */
    _chartIncome(students) {
      const order  = ['Low', 'Medium', 'High'];
      const groups = groupBy(students, 'family_income_level');
      const labels = order.filter((k) => groups[k]);
      const avgs   = labels.map((k) => r1(avg(groups[k].map((s) => s.exam_score))));
      const counts = labels.map((k) => groups[k].length);

      this._makeChart('chartIncome', {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label:           'Avg Exam Score',
            data:            avgs,
            backgroundColor: ['rgba(14,165,233,0.75)', 'rgba(99,102,241,0.75)', 'rgba(168,85,247,0.75)'],
            borderColor:     ['rgba(14,165,233,1)',     'rgba(99,102,241,1)',     'rgba(168,85,247,1)'],
            borderWidth:     1,
            borderRadius:    5,
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                afterLabel: (ctx) => `  Count: ${counts[ctx.dataIndex]} students`,
              },
            },
          },
          scales: {
            x: {
              grid: { color: '#f1f5f9' },
              beginAtZero: true,
              max: 100,
              title: { display: true, text: 'Avg Score', color: '#94a3b8' },
              ticks: { color: '#64748b' },
            },
            y: {
              grid: { display: false },
              ticks: { color: '#334155', font: { weight: '600' } },
            },
          },
        },
      });
    },

    /* ─── Chart 6: Avg Score by Health Status (bar) ──────── */
    _chartHealth(students) {
      const order  = ['Excellent', 'Good', 'Fair', 'Poor'];
      const groups = groupBy(students, 'health');
      const labels = order.filter((k) => groups[k]);
      const avgs   = labels.map((k) => r1(avg(groups[k].map((s) => s.exam_score))));
      const counts = labels.map((k) => groups[k].length);

      const BG = {
        Excellent: 'rgba(20,184,166,0.75)',
        Good:      'rgba(14,165,233,0.75)',
        Fair:      'rgba(245,158,11,0.75)',
        Poor:      'rgba(244,63,94,0.75)',
      };

      this._makeChart('chartHealth', {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label:           'Avg Exam Score',
            data:            avgs,
            backgroundColor: labels.map((l) => BG[l]),
            borderColor:     labels.map((l) => BG[l].replace('0.75', '1')),
            borderWidth:     1,
            borderRadius:    5,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                afterLabel: (ctx) => `  Count: ${counts[ctx.dataIndex]} students`,
              },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: '#334155', font: { weight: '600' } },
            },
            y: {
              grid: { color: '#f1f5f9' },
              beginAtZero: true,
              max: 100,
              title: { display: true, text: 'Avg Score', color: '#94a3b8' },
              ticks: { color: '#64748b' },
            },
          },
        },
      });
    },

    /* ─── Chart 7: Avg Score by Parental Education (bar) ─── */
    _chartParentEdu(students) {
      const order  = ['Primary', 'Secondary', 'Graduate', 'Postgraduate'];
      const groups = groupBy(students, 'parental_education_level');
      const labels = order.filter((k) => groups[k]);
      const avgs   = labels.map((k) => r1(avg(groups[k].map((s) => s.exam_score))));
      const counts = labels.map((k) => groups[k].length);

      this._makeChart('chartParentEdu', {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label:           'Avg Exam Score',
            data:            avgs,
            backgroundColor: [
              'rgba(236,72,153,0.75)',
              'rgba(168,85,247,0.75)',
              'rgba(99,102,241,0.75)',
              'rgba(20,184,166,0.75)',
            ],
            borderColor: [
              'rgba(236,72,153,1)',
              'rgba(168,85,247,1)',
              'rgba(99,102,241,1)',
              'rgba(20,184,166,1)',
            ],
            borderWidth:  1,
            borderRadius: 5,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                afterLabel: (ctx) => `  Count: ${counts[ctx.dataIndex]} students`,
              },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: '#334155', font: { weight: '600' }, maxRotation: 20 },
            },
            y: {
              grid: { color: '#f1f5f9' },
              beginAtZero: true,
              max: 100,
              title: { display: true, text: 'Avg Score', color: '#94a3b8' },
              ticks: { color: '#64748b' },
            },
          },
        },
      });
    },

  })); // end Alpine.data('dashboard', ...)
});

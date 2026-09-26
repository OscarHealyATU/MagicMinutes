import React from 'react';

// A top-level safety net: without this, one bad document (a session with no
// `activity`, a note whose `tags` came in as a string) throwing during render
// takes the whole app down to a blank white page — React 19 unmounts the
// entire root on an uncaught render error, sidebar and all, with no way back
// in short of restarting the app. Error boundaries can only be class
// components (there's no Hooks equivalent for getDerivedStateFromError /
// componentDidCatch), so this one stays a class even though everything else
// here is function components.
//
// This wraps <App/> in main.jsx, which is as deep as it can reach: the
// per-tab views (Notes, Map, Characters, …) are chosen and rendered inside
// App.jsx itself, so wrapping each of *those* individually would mean editing
// App.jsx — out of scope here. One crash still takes down the current tab
// and everything around it (App re-mounts fresh on "Try again"), but at
// least the player gets a message and a way out instead of a blank page.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleReset = this.handleReset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // There's no crash-reporting service here (everything runs offline, on
    // the player's own machine) — the console is the only place this goes,
    // so at least it's not silently swallowed.
    // eslint-disable-next-line no-console
    console.error('MagicMinutes crashed while rendering:', error, info && info.componentStack);
  }

  handleReset() {
    this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-boundary">
        <div className="error-boundary-card">
          <div className="error-boundary-icon" aria-hidden="true">⚠</div>
          <h2>Something went wrong</h2>
          <p>
            MagicMinutes hit an error it couldn't recover from on its own — most likely one
            document with something odd in it, often after an import. Your data on disk hasn't
            been touched.
          </p>
          <p>
            Try again first. If it keeps happening, go to <strong>Settings → Backup &amp; transfer</strong> and
            export a backup before doing anything else, so you have a safe copy while you track
            down which note, place or NPC is causing it.
          </p>
          <div className="error-boundary-actions">
            <button className="btn primary" onClick={this.handleReset}>↻ Try again</button>
          </div>
          <details className="error-boundary-details">
            <summary>Technical details</summary>
            <pre>{String((this.state.error && this.state.error.stack) || this.state.error)}</pre>
          </details>
        </div>
      </div>
    );
  }
}

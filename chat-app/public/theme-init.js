// Apply the stored/system theme before first paint to avoid a flash.
      // Mirrors the resolution logic in src/lib/theme-store.ts.
      (function () {
        try {
          var key = 'chat-app-theme';
          var pref = localStorage.getItem(key);
          var dark =
            pref === 'dark' ||
            ((!pref || pref === 'system') &&
              window.matchMedia('(prefers-color-scheme: dark)').matches);
          if (dark) document.documentElement.classList.add('dark');
        } catch (e) {
          /* ignore */
        }
      })();

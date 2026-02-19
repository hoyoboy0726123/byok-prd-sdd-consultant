
import { bootstrapApplication } from '@angular/platform-browser';
import { provideZonelessChangeDetection } from '@angular/core';
import { AppComponent } from './app.component';

bootstrapApplication(AppComponent, {
  providers: [
    provideZonelessChangeDetection()
  ]
}).catch(err => {
  console.error('Application bootstrap failed:', err);
  document.body.innerHTML = `<div style="padding: 20px; color: red;"><h1>Application Error</h1><p>Failed to start application.</p><pre>${err.message}</pre></div>`;
});

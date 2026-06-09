import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// Prevent accidental value changes when the mouse wheel scrolls over a
// focused number input — blur it so the page scrolls instead.
document.addEventListener('wheel', () => {
  if (document.activeElement?.type === 'number') document.activeElement.blur();
}, { passive: true });

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

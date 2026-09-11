import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import BodyWindow from './components/BodyWindow';
import './styles.css';

/** 弹窗和主窗口共用同一个 bundle，靠 query 参数分流：有 ?body=<token> 就是弹窗。 */
const bodyToken = new URLSearchParams(window.location.search).get('body');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{bodyToken ? <BodyWindow token={bodyToken} /> : <App />}</React.StrictMode>,
);

import './styles/main.css';
import { render } from 'preact';
import { App } from './App';

const root = document.getElementById('root');
if (root) render(<App />, root);

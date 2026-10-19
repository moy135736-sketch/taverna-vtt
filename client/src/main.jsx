import '@fontsource/alegreya/cyrillic-400.css';
import '@fontsource/alegreya/cyrillic-700.css';
import '@fontsource/alegreya/latin-400.css';
import '@fontsource/alegreya/latin-700.css';
import '@fontsource/alegreya-sans/cyrillic-400.css';
import '@fontsource/alegreya-sans/cyrillic-500.css';
import '@fontsource/alegreya-sans/cyrillic-700.css';
import '@fontsource/alegreya-sans/latin-400.css';
import '@fontsource/alegreya-sans/latin-500.css';
import '@fontsource/alegreya-sans/latin-700.css';
import './styles/app.css';
import { render } from 'preact';
import { App } from './App.jsx';
import { applyTeapot, onTeapot } from './ui/teapot.js';

// режим чайника — класс на <html> сразу, до первой отрисовки; включили в другой вкладке — и здесь
applyTeapot();
onTeapot(() => {});
render(<App />, document.getElementById('app'));

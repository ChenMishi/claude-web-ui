import { AppContextProvider } from './context/AppContext';
import Layout from './components/Layout';
import './styles/index.css';

export default function App() {
  return (
    <AppContextProvider>
      <Layout />
    </AppContextProvider>
  );
}

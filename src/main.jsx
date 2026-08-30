import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import TaskGraphWindow from './TaskGraphWindow.jsx'
import ReviewWindow from './ReviewWindow.jsx'
import { StoreProvider } from './store.jsx'
import { I18nProvider } from './i18n.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import './index.css'

const isTaskWindow = new URLSearchParams(window.location.search).get('taskWindow') === '1'
const isReviewWindow = new URLSearchParams(window.location.search).get('reviewWindow') === '1'

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <I18nProvider>
      {isReviewWindow ? (
        <ReviewWindow />
      ) : isTaskWindow ? (
        <TaskGraphWindow />
      ) : (
        <StoreProvider>
          <App />
        </StoreProvider>
      )}
    </I18nProvider>
  </ErrorBoundary>
)

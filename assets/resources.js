'use strict';

window.DaevanionResources = (root, planner, onAction) => {
  const notice = root.querySelector('.resource-notice');
  root.querySelector('.reset-all').addEventListener('click', () => onAction('reset-all'));
  root.querySelector('.load-source').addEventListener('click', () => onAction('load-source'));
  return {
    render(message = '', error = false) {
      root.querySelector('.budget-total').textContent = planner.total.toLocaleString('ko-KR');
      root.querySelector('.budget-used').textContent = planner.used().toLocaleString('ko-KR');
      const remaining = planner.remaining();
      root.querySelector('.budget-remaining').textContent = remaining.toLocaleString('ko-KR');
      notice.textContent = message;
      notice.classList.toggle('is-error', error);
    }
  };
};

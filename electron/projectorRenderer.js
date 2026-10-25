'use strict';
window.yayraProjection?.onFrame?.((frame) => {
  const image = document.getElementById('projection');
  if (image) image.src = frame;
});

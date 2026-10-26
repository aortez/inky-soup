// Keep receipts for unavailable frames even while another frame is selected.
export function savedJobs(storage) {
  const key = 'sparkle-frame-jobs-v1';
  function legacy() {return JSON.parse(storage.getItem('sparkle-job'));}
  function read() {
    const jobs = JSON.parse(storage.getItem(key)) || {};
    const previous = legacy();
    if (previous?.deviceId && !jobs[previous.deviceId]) jobs[previous.deviceId] = previous;
    return jobs;
  }
  return {
    get(deviceId) {
      const jobs = read();
      const previous = legacy();
      return jobs[deviceId] || (previous && !previous.deviceId ? previous : null);
    },
    put(job) {
      const jobs = read();
      if (job.deviceId) jobs[job.deviceId] = job;
      storage.setItem(key, JSON.stringify(jobs));
      storage.setItem('sparkle-job', JSON.stringify(job));
    },
    remove(deviceId) {
      const jobs = read();
      delete jobs[deviceId];
      storage.setItem(key, JSON.stringify(jobs));
      const previous = legacy();
      if (!previous?.deviceId || previous.deviceId === deviceId) storage.removeItem('sparkle-job');
    },
  };
}

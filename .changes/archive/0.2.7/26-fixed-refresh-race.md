category: Fixed

- A concurrent credential refresh no longer reports a missing credential for a healthy GitLab or Factory Droid account: the losing request now reads the refresh the winner already committed instead of failing.

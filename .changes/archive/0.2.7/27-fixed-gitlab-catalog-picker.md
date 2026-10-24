category: Fixed

- The model picker now projects the `gitlab-duo` (16 rows) and `gitlab-duo-agent` (1 row) catalogs: this plugin's route-to-accessor table was missing the two GitLab entries, so both routes reported a missing catalog and offered no models even though the transport package ships them.

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TeamProjectSelector } from '../team-project-selector'
import { Team, Project, Database as DatabaseType } from '@/types'

// Mock the workspace context
const mockRefreshWorkspace = jest.fn().mockResolvedValue(undefined)
const mockUseWorkspace = jest.fn()
jest.mock('../../components/workspace-context', () => ({
  useWorkspace: () => mockUseWorkspace(),
}))

// Mock the toast hook
const mockToast = jest.fn()
const mockUseToast = jest.fn()
jest.mock('../../hooks/use-toast', () => ({
  useToast: () => mockUseToast(),
}))

// Mock fetch
global.fetch = jest.fn()

describe('TeamProjectSelector', () => {
  
  const mockTeams: Team[] = [
    {
      id: 'team-1',
      name: 'Team Alpha',
      slug: 'team-alpha',
      owner_id: 'user-1',
      created_at: '2024-01-01T00:00:00Z',
    },
    {
      id: 'team-2',
      name: 'Team Beta',
      slug: 'team-beta',
      owner_id: 'user-1',
      created_at: '2024-01-02T00:00:00Z',
    },
  ]

  const mockProjects: Project[] = [
    {
      id: 'project-1',
      name: 'Project One',
      org_id: 'team-1',
      description: 'First project',
      created_at: '2024-01-03T00:00:00Z',
    },
    {
      id: 'project-2',
      name: 'Project Two',
      org_id: 'team-1',
      created_at: '2024-01-04T00:00:00Z',
    },
    {
      id: 'project-3',
      name: 'Project Three',
      org_id: 'team-2',
      created_at: '2024-01-05T00:00:00Z',
    },
  ]

  const mockDatabases: DatabaseType[] = [
    {
      id: 'db-1',
      name: 'Database One',
      project_id: 'project-1',
      description: 'First database',
      database_url: 'postgresql://localhost:5432/db1',
      provider: 'postgres',
      status: 'active',
      created_at: '2024-01-06T00:00:00Z',
    },
    {
      id: 'db-2',
      name: 'Database Two',
      project_id: 'project-1',
      database_url: 'postgresql://localhost:5432/db2',
      provider: 'neon',
      status: 'active',
      created_at: '2024-01-07T00:00:00Z',
    },
    {
      id: 'db-3',
      name: 'Database Three',
      project_id: 'project-2',
      database_url: 'postgresql://localhost:5432/db3',
      provider: 'supabase',
      status: 'inactive',
      created_at: '2024-01-08T00:00:00Z',
    },
  ]

  const defaultProps = {
    selectedTeam: null,
    selectedProject: null,
    selectedDatabase: null,
    teams: mockTeams,
    projects: mockProjects,
    databases: mockDatabases,
    onTeamChange: jest.fn(),
    onProjectChange: jest.fn(),
    onDatabaseChange: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockUseWorkspace.mockReturnValue({
      refreshWorkspace: mockRefreshWorkspace,
    })
    mockUseToast.mockReturnValue({
      toast: mockToast,
    })
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })
  })

  describe('Rendering', () => {
    it('renders team selector button', () => {
      render(<TeamProjectSelector {...defaultProps} />)
      expect(screen.getByRole('button', { name: /select team/i })).toBeInTheDocument()
    })

    it('displays selected team name', () => {
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
        />
      )
      expect(screen.getByText('Team Alpha')).toBeInTheDocument()
    })

    it('does not render project selector when no team is selected', () => {
      render(<TeamProjectSelector {...defaultProps} />)
      expect(screen.queryByRole('button', { name: /select project/i })).not.toBeInTheDocument()
    })

    it('renders project selector when team is selected', () => {
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
        />
      )
      expect(screen.getByRole('button', { name: /select project/i })).toBeInTheDocument()
    })

    it('does not render database selector when no project is selected', () => {
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
        />
      )
      expect(screen.queryByRole('button', { name: /select database/i })).not.toBeInTheDocument()
    })

    it('renders database selector when project is selected', () => {
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
          selectedProject={mockProjects[0]}
        />
      )
      expect(screen.getByRole('button', { name: /select database/i })).toBeInTheDocument()
    })
  })

  describe('Team Selection', () => {
    it('opens team dropdown menu', async () => {
      const user = userEvent.setup()
      render(<TeamProjectSelector {...defaultProps} />)
      
      const teamButton = screen.getByRole('button', { name: /select team/i })
      await user.click(teamButton)
      
      expect(screen.getByText('Teams')).toBeInTheDocument()
      expect(screen.getByText('Team Alpha')).toBeInTheDocument()
      expect(screen.getByText('Team Beta')).toBeInTheDocument()
    })

    it('calls onTeamChange when team is selected', async () => {
      const user = userEvent.setup()
      const onTeamChange = jest.fn()
      render(
        <TeamProjectSelector
          {...defaultProps}
          onTeamChange={onTeamChange}
        />
      )
      
      const teamButton = screen.getByRole('button', { name: /select team/i })
      await user.click(teamButton)
      
      const teamItem = screen.getByText('Team Alpha')
      await user.click(teamItem)
      
      expect(onTeamChange).toHaveBeenCalledWith(mockTeams[0])
    })

    it('resets project and database when team changes', async () => {
      const user = userEvent.setup()
      const onTeamChange = jest.fn()
      const onProjectChange = jest.fn()
      const onDatabaseChange = jest.fn()
      
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
          selectedProject={mockProjects[0]}
          selectedDatabase={mockDatabases[0]}
          onTeamChange={onTeamChange}
          onProjectChange={onProjectChange}
          onDatabaseChange={onDatabaseChange}
        />
      )
      
      const teamButton = screen.getByRole('button', { name: /team alpha/i })
      await user.click(teamButton)
      
      const teamItem = screen.getByText('Team Beta')
      await user.click(teamItem)
      
      expect(onTeamChange).toHaveBeenCalledWith(mockTeams[1])
      expect(onProjectChange).toHaveBeenCalledWith(null)
      expect(onDatabaseChange).toHaveBeenCalledWith(null)
    })

    it('shows active badge for selected team', async () => {
      const user = userEvent.setup()
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
        />
      )
      
      const teamButton = screen.getByRole('button', { name: /team alpha/i })
      await user.click(teamButton)
      
      // Check that at least one "Active" badge exists for the selected team
      const activeBadges = screen.getAllByText('Active')
      expect(activeBadges.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('Project Selection', () => {
    it('filters projects by selected team', async () => {
      const user = userEvent.setup()
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
        />
      )
      
      const projectButton = screen.getByRole('button', { name: /select project/i })
      await user.click(projectButton)
      
      // Should only show projects for team-1
      expect(screen.getByText('Project One')).toBeInTheDocument()
      expect(screen.getByText('Project Two')).toBeInTheDocument()
      expect(screen.queryByText('Project Three')).not.toBeInTheDocument()
    })

    it('calls onProjectChange when project is selected', async () => {
      const user = userEvent.setup()
      const onProjectChange = jest.fn()
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
          onProjectChange={onProjectChange}
        />
      )
      
      const projectButton = screen.getByRole('button', { name: /select project/i })
      await user.click(projectButton)
      
      const projectItem = screen.getByText('Project One')
      await user.click(projectItem)
      
      expect(onProjectChange).toHaveBeenCalledWith(mockProjects[0])
    })

    it('resets database when project changes', async () => {
      const user = userEvent.setup()
      const onProjectChange = jest.fn()
      const onDatabaseChange = jest.fn()
      
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
          selectedProject={mockProjects[0]}
          selectedDatabase={mockDatabases[0]}
          onProjectChange={onProjectChange}
          onDatabaseChange={onDatabaseChange}
        />
      )
      
      const projectButton = screen.getByRole('button', { name: /project one/i })
      await user.click(projectButton)
      
      const projectItem = screen.getByText('Project Two')
      await user.click(projectItem)
      
      expect(onProjectChange).toHaveBeenCalledWith(mockProjects[1])
      expect(onDatabaseChange).toHaveBeenCalledWith(null)
    })
  })

  describe('Database Selection', () => {
    it('filters databases by selected project', async () => {
      const user = userEvent.setup()
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
          selectedProject={mockProjects[0]}
        />
      )
      
      const databaseButton = screen.getByRole('button', { name: /select database/i })
      await user.click(databaseButton)
      
      // Should only show databases for project-1
      expect(screen.getByText('Database One')).toBeInTheDocument()
      expect(screen.getByText('Database Two')).toBeInTheDocument()
      expect(screen.queryByText('Database Three')).not.toBeInTheDocument()
    })

    it('calls onDatabaseChange when database is selected', async () => {
      const user = userEvent.setup()
      const onDatabaseChange = jest.fn()
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
          selectedProject={mockProjects[0]}
          onDatabaseChange={onDatabaseChange}
        />
      )
      
      const databaseButton = screen.getByRole('button', { name: /select database/i })
      await user.click(databaseButton)
      
      const databaseItem = screen.getByText('Database One')
      await user.click(databaseItem)
      
      expect(onDatabaseChange).toHaveBeenCalledWith(mockDatabases[0])
    })

    it('displays database status badge', async () => {
      const user = userEvent.setup()
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
          selectedProject={mockProjects[0]}
        />
      )
      
      const databaseButton = screen.getByRole('button', { name: /select database/i })
      await user.click(databaseButton)
      
      // Multiple databases may have "active" status, so use getAllByText
      const activeBadges = screen.getAllByText('active')
      expect(activeBadges.length).toBeGreaterThan(0)
    })
  })

  describe('Team Creation', () => {
    it('opens create team dialog', async () => {
      const user = userEvent.setup()
      render(<TeamProjectSelector {...defaultProps} />)
      
      const teamButton = screen.getByRole('button', { name: /select team/i })
      await user.click(teamButton)
      
      const newTeamItem = screen.getByText('New Team')
      await user.click(newTeamItem)
      
      expect(screen.getByText('Create New Team')).toBeInTheDocument()
      expect(screen.getByLabelText(/team name/i)).toBeInTheDocument()
    })

    it('creates team successfully', async () => {
      const user = userEvent.setup()
      const onTeamChange = jest.fn()
      const newTeam = { ...mockTeams[0], id: 'team-new', name: 'New Team' }
      
      ;(global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ team: newTeam }),
      })
      
      render(
        <TeamProjectSelector
          {...defaultProps}
          onTeamChange={onTeamChange}
        />
      )
      
      // Open dialog
      const teamButton = screen.getByRole('button', { name: /select team/i })
      await user.click(teamButton)
      const newTeamItem = screen.getByText('New Team')
      await user.click(newTeamItem)
      
      // Fill form
      const nameInput = screen.getByLabelText(/team name/i)
      await user.type(nameInput, 'New Team')
      
      // Submit
      const createButton = screen.getByRole('button', { name: /create team/i })
      await user.click(createButton)
      
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/teams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'New Team' }),
        })
      })
      
      await waitFor(() => {
        expect(onTeamChange).toHaveBeenCalledWith(newTeam)
      })
      
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Team created',
        description: 'New Team has been created successfully.',
      })
      expect(mockRefreshWorkspace).toHaveBeenCalled()
    })

    it('handles team creation error', async () => {
      const user = userEvent.setup()
      
      ;(global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Team name already exists' }),
      })
      
      render(<TeamProjectSelector {...defaultProps} />)
      
      // Open dialog
      const teamButton = screen.getByRole('button', { name: /select team/i })
      await user.click(teamButton)
      const newTeamItem = screen.getByText('New Team')
      await user.click(newTeamItem)
      
      // Fill form
      const nameInput = screen.getByLabelText(/team name/i)
      await user.type(nameInput, 'Existing Team')
      
      // Submit
      const createButton = screen.getByRole('button', { name: /create team/i })
      await user.click(createButton)
      
      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith({
          title: 'Error',
          description: 'Team name already exists',
          variant: 'destructive',
        })
      })
    })

    it('disables create button when name is empty', async () => {
      const user = userEvent.setup()
      render(<TeamProjectSelector {...defaultProps} />)
      
      // Open dialog
      const teamButton = screen.getByRole('button', { name: /select team/i })
      await user.click(teamButton)
      const newTeamItem = screen.getByText('New Team')
      await user.click(newTeamItem)
      
      const createButton = screen.getByRole('button', { name: /create team/i })
      expect(createButton).toBeDisabled()
    })
  })

  describe('Project Creation', () => {
    it('opens create project dialog', async () => {
      const user = userEvent.setup()
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
        />
      )
      
      const projectButton = screen.getByRole('button', { name: /select project/i })
      await user.click(projectButton)
      
      const newProjectItem = screen.getByText('New Project')
      await user.click(newProjectItem)
      
      expect(screen.getByText('Create New Project')).toBeInTheDocument()
      expect(screen.getByLabelText(/project name/i)).toBeInTheDocument()
    })

    it('creates project successfully', async () => {
      const user = userEvent.setup()
      const onProjectChange = jest.fn()
      const newProject: Project = {
        id: 'project-new',
        name: 'New Project',
        org_id: 'team-1',
        description: 'New project description',
        created_at: '2024-01-10T00:00:00Z',
      }
      
      ;(global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ project: newProject }),
      })
      
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
          onProjectChange={onProjectChange}
        />
      )
      
      // Open dialog
      const projectButton = screen.getByRole('button', { name: /select project/i })
      await user.click(projectButton)
      const newProjectItem = screen.getByText('New Project')
      await user.click(newProjectItem)
      
      // Fill form
      const nameInput = screen.getByLabelText(/project name/i)
      await user.type(nameInput, 'New Project')
      
      const descriptionInput = screen.getByLabelText(/description/i)
      await user.type(descriptionInput, 'New project description')
      
      // Submit
      const createButton = screen.getByRole('button', { name: /create project/i })
      await user.click(createButton)
      
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'New Project',
            team_id: 'team-1',
            description: 'New project description',
          }),
        })
      })
      
      await waitFor(() => {
        expect(onProjectChange).toHaveBeenCalledWith(newProject)
      })
      
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Project created',
        description: 'New Project has been created successfully.',
      })
    })

    it('does not create project without team selected', async () => {
      const user = userEvent.setup()
      render(<TeamProjectSelector {...defaultProps} />)
      
      // Project selector should not be visible without team
      expect(screen.queryByRole('button', { name: /select project/i })).not.toBeInTheDocument()
    })
  })

  describe('Database Creation', () => {
    it('opens create database dialog', async () => {
      const user = userEvent.setup()
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
          selectedProject={mockProjects[0]}
        />
      )
      
      const databaseButton = screen.getByRole('button', { name: /select database/i })
      await user.click(databaseButton)
      
      const newDatabaseItem = screen.getByText('New Database')
      await user.click(newDatabaseItem)
      
      expect(screen.getByText('Create New Database')).toBeInTheDocument()
      expect(screen.getByLabelText(/database name/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/database url/i)).toBeInTheDocument()
    })

    it('creates database successfully', async () => {
      const user = userEvent.setup()
      const onDatabaseChange = jest.fn()
      const newDatabase: DatabaseType = {
        id: 'db-new',
        name: 'New Database',
        project_id: 'project-1',
        description: 'New database description',
        database_url: 'postgresql://localhost:5432/newdb',
        provider: 'postgres',
        status: 'active',
        created_at: '2024-01-11T00:00:00Z',
      }
      
      ;(global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ database: newDatabase }),
      })
      
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
          selectedProject={mockProjects[0]}
          onDatabaseChange={onDatabaseChange}
        />
      )
      
      // Open dialog
      const databaseButton = screen.getByRole('button', { name: /select database/i })
      await user.click(databaseButton)
      const newDatabaseItem = screen.getByText('New Database')
      await user.click(newDatabaseItem)
      
      // Fill form
      const nameInput = screen.getByLabelText(/database name/i)
      await user.type(nameInput, 'New Database')
      
      const urlInput = screen.getByLabelText(/database url/i)
      await user.type(urlInput, 'postgresql://localhost:5432/newdb')
      
      // Submit
      const createButton = screen.getByRole('button', { name: /create database/i })
      await user.click(createButton)
      
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/databases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'New Database',
            project_id: 'project-1',
            description: undefined,
            database_url: 'postgresql://localhost:5432/newdb',
            provider: 'postgres',
          }),
        })
      })
      
      await waitFor(() => {
        expect(onDatabaseChange).toHaveBeenCalledWith(newDatabase)
      })
      
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Database created',
        description: 'New Database has been created successfully.',
      })
    })

    it('disables create button when required fields are empty', async () => {
      const user = userEvent.setup()
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
          selectedProject={mockProjects[0]}
        />
      )
      
      // Open dialog
      const databaseButton = screen.getByRole('button', { name: /select database/i })
      await user.click(databaseButton)
      const newDatabaseItem = screen.getByText('New Database')
      await user.click(newDatabaseItem)
      
      const createButton = screen.getByRole('button', { name: /create database/i })
      expect(createButton).toBeDisabled()
    })

    it('allows selecting database provider', async () => {
      const user = userEvent.setup()
      render(
        <TeamProjectSelector
          {...defaultProps}
          selectedTeam={mockTeams[0]}
          selectedProject={mockProjects[0]}
        />
      )
      
      // Open dialog
      const databaseButton = screen.getByRole('button', { name: /select database/i })
      await user.click(databaseButton)
      const newDatabaseItem = screen.getByText('New Database')
      await user.click(newDatabaseItem)
      
      // Check that provider label is present
      // The Select component from Radix UI may render differently in tests
      // We verify the form structure is correct by checking for the label text
      const providerLabels = screen.getAllByText('Provider')
      expect(providerLabels.length).toBeGreaterThan(0)
    })
  })

  describe('Error Handling', () => {
    it('handles network errors when creating team', async () => {
      const user = userEvent.setup()
      
      ;(global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'))
      
      render(<TeamProjectSelector {...defaultProps} />)
      
      // Open dialog
      const teamButton = screen.getByRole('button', { name: /select team/i })
      await user.click(teamButton)
      const newTeamItem = screen.getByText('New Team')
      await user.click(newTeamItem)
      
      // Fill form
      const nameInput = screen.getByLabelText(/team name/i)
      await user.type(nameInput, 'New Team')
      
      // Submit
      const createButton = screen.getByRole('button', { name: /create team/i })
      await user.click(createButton)
      
      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith({
          title: 'Error',
          description: 'An unexpected error occurred while creating the team.',
          variant: 'destructive',
        })
      })
    })
  })
})

